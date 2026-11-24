import QControl.QCCD
import QControl.NeutralLayout
import QControl.StudioPlacement
import QControl.Controller
import QControl.Fabric
import QControl.Validation
import QControl.RiscQ.Soc
open Lean QControl

private def readProgram (document : Json) : Except String Program := do
  let p : Program ← fromJson? document
  unless document == toJson p do
    throw "Unexpected program or placement field. Use the version 1 program format."
  p.validate
  return p

private def transcript (p : Program) (frames : List Frame) : Json :=
  Json.mkObj [("program", toJson p), ("assemblies", toJson assemblies),
    ("initial", toJson ({} : State)), ("frames", toJson frames)]

private def readController (doc : Json) : Except String Controller.Program := do
  let p : Controller.Program ← fromJson? doc
  unless doc == toJson p do throw "Unexpected controller profile or instruction field."
  p.validate
  return p

private def runDocument (doc : Json) : Except String Json := do
  if let .ok kind := doc.getObjVal? "kind" then
    if kind == toJson "component-machine" then
      let p : Fabric.Program ← fromJson? doc
      unless doc == toJson p do throw "Unexpected component machine field."
      return ← Fabric.run p
    if kind == toJson "riscq-soc" then
      let p : RiscQ.Program ← fromJson? doc
      unless doc == toJson p do throw "Unexpected RISC-Q program, core or channel field."
      p.validate
      return RiscQ.run p
    if kind == toJson "waveform-controller" then
      let p ← readController doc
      let system ← Json.parse (include_str "physical/qccd-installation.json")
      return (Controller.run p).setObjVal! "system" system
    if kind == toJson "neutral-aod" then
      let p : Neutral.Program ← fromJson? doc
      unless doc == toJson p do throw "Unexpected neutral-atom program, atom or tone move field."
      p.validate
      return Json.mkObj [("program", toJson p), ("assemblies", toJson (Neutral.geometry p)),
        ("system", Neutral.physicalSystem p),
        ("initial", toJson (Neutral.initial p)), ("frames", toJson (Neutral.run p))]
    unless kind == toJson "qccd-broadcast" do throw "Unknown bench program kind."
    let p : QCCD.Program ← fromJson? doc
    unless doc == toJson p do throw "Unexpected QCCD program, lane or waveform field."
    p.validate
    return Json.mkObj [("program", toJson p), ("assemblies", toJson (QCCD.geometry p)),
      ("system", ← Json.parse (include_str "physical/qccd-installation.json")),
      ("initial", toJson (QCCD.initial p)), ("frames", toJson (QCCD.run p))]
  let p ← readProgram doc
  return transcript p (run p)

/-- Recompute from the embedded program and locate the first divergent microstep. -/
private def checkTrace (document : Json) : Except String Json := do
  let expected ← runDocument (← document.getObjVal? "program")
  let frames ← (← expected.getObjVal? "frames").getArr?
  let supplied ← (← document.getObjVal? "frames").getArr?
  for (f, i) in frames.zipIdx do
    unless supplied[i]? == some f do
      let id ← f.getObjVal? "id"
      if let .ok time := f.getObjVal? "atNs" then
        throw s!"Trace mismatch at step {i + 1}, event {id.getStr?.toOption.getD id.compress}, time {time} ns."
      throw s!"Trace mismatch at step {i + 1}, event {id}, time {← f.getObjVal? "atPs"} ps."
  unless supplied.size == frames.size do throw "Extra event after the final step."
  -- Version 1 bench exports made before physical installation profiles omitted this header.
  let expectedObj ← expected.getObj?
  let kind := ((← document.getObjVal? "program").getObjVal? "kind").toOption
  let header := if (document.getObjVal? "system").isOk || kind == some (toJson "waveform-controller") then expected
    else Json.obj (expectedObj.erase "system")
  unless document == header do throw "Trace header or physical assemblies differ."
  return Json.mkObj [("verified", true), ("events", toJson frames.size)]

/-- Run or check a versioned bench document supplied on stdin. -/
def main (args : List String) : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  let result : Except String Json := do
    let document ← Json.parse input
    match args with
    | [] => runDocument document
    | ["--check-machine"] => do
      let p : Fabric.Program ← fromJson? document
      unless document == toJson p do throw "Unexpected component machine field."
      p.validate
      return Json.mkObj [("verified", true)]
    | ["--component-ports"] => do
      let models : Array Fabric.Primitive ← fromJson? document
      return toJson (models.map fun m ↦ Json.mkObj [
        ("inputs", toJson m.inputs), ("outputs", toJson m.outputs)])
    | ["--capture-samples"] => do
      let programs ← document.getArr?
      unless programs.size ≤ 16 do throw "Capture at most 16 programs per batch."
      return toJson (← programs.mapM (fun d ↦ do return Controller.run (← readController d) true))
    | ["--check-trace"] => checkTrace document
    | ["--check-validation"] => Validation.check document
    | ["--check-studio-placement"] => StudioPlacement.check document
    | _ => throw "Usage: qcontrol [--check-machine | --component-ports | --check-trace | --check-studio-placement | --capture-samples | --check-validation] < input.json"
  match result with
  | .ok j => IO.println j.compress; return 0
  | .error e => (← IO.getStderr).putStrLn e; return 1
