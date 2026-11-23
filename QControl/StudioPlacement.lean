import Lean
import Lean.Data.Json.FromToJson.Extra
import Std.Data.TreeMap.Lemmas

namespace QControl.StudioPlacement
open Lean

/-- A logical ion occupies one Studio site. A cycle commits all its new locations together. -/
abbrev Placement := Std.TreeMap String String

def commit (before : Placement) (updates : List (String × String)) : Placement :=
  before.insertMany updates

/-- A simultaneous transport or placement leaves each unaddressed ion at its previous site. -/
theorem unaddressed_stays (before : Placement) (updates : List (String × String)) (ion : String)
    (h : (updates.map Prod.fst).contains ion = false) :
    (commit before updates)[ion]? = before[ion]? :=
  Std.TreeMap.getElem?_insertMany_list_of_contains_eq_false h

structure Edge where
  id : String
  a : String
  b : String
  deriving FromJson

structure Route where
  ion : String
  «from» : String
  to : String
  via : List String
  deriving FromJson

structure Frame where
  id : String
  sourceId : Int
  sourceIndex : Nat
  substep : Nat
  op : String
  parents : List String
  targets : List String
  moves : List Route
  positions : Placement
  deriving FromJson

private def walk (edges : Std.TreeMap String Edge) (route : Route) : Except String String := do
  let mut here := route.from
  for id in route.via do
    let some e := edges[id]? | throw s!"unknown rail {id}"
    if e.a == here then here := e.b
    else if e.b == here then here := e.a
    else throw s!"rail {id} is disconnected from {here}"
  unless here == route.to do throw s!"route ends at {here}, expected {route.to}"
  return here

private def transition (nodes : Std.TreeSet String) (edges : Std.TreeMap String Edge)
    (before : Placement) (source : Json) (f : Frame) : Except String Placement := do
  unless f.targets.all nodes.contains do throw "addressed site is missing from the geometry"
  let mut updates : List (String × String) := []
  if f.op == "init" then
    let placement : Placement ← fromJson? ((source.getObjVal? "placement").toOption.getD (Json.mkObj []))
    updates := placement.toList
  else if f.op == "simd" then
    for m in f.moves do
      unless before[m.ion]? == some m.from do throw s!"{m.ion} did not start at {m.from}"
      updates := (m.ion, ← walk edges m) :: updates
    updates := updates.reverse
  unless f.op == "simd" || f.moves.isEmpty do throw "unexpected physical route"
  unless updates.all (fun u ↦ nodes.contains u.2) do throw "unknown destination site"
  let after := commit before updates
  unless after.toList == (commit before f.positions.toList).toList do
    throw "displayed placement differs from source initialization or resolved rail routes"
  return after

/-- Independently check the placement projection exported by the Studio interpreter. -/
def check (doc : Json) : Except String Json := do
  unless (← doc.getObjVal? "schema") == toJson "qcontrol.qccd-studio.v1" do
    throw "Unsupported Studio replay schema."
  let machine ← doc.getObjVal? "machine"
  let mut nodes : Std.TreeSet String := {}
  for n in ← (← machine.getObjVal? "nodes").getArr? do
    let id ← (← n.getObjVal? "id").getStr?
    if nodes.contains id then throw s!"Duplicate site {id}."
    nodes := nodes.insert id
  let segments : List Edge ← fromJson? (← machine.getObjVal? "segments")
  let mut edges : Std.TreeMap String Edge := {}
  for e in segments do
    unless nodes.contains e.a && nodes.contains e.b && !edges.contains e.id do
      throw s!"Invalid or duplicate rail {e.id}."
    edges := edges.insert e.id e
  let sources ← (← doc.getObjVal? "sourceInstructions").getArr?
  let frames ← (← doc.getObjVal? "frames").getArr?
  let initial ← (← doc.getObjVal? "initial").getObjVal? "positions"
  unless initial == Json.mkObj [] do throw "Expected an empty pre-program placement."
  let mut positions : Placement := {}
  let mut previous : Option Frame := none
  for entry in frames do
    let f : Frame ← fromJson? entry
    let some src := sources[f.sourceIndex]? | throw s!"{f.id}: unknown source instruction"
    unless (← src.getObjVal? "id") == toJson f.sourceId && (← src.getObjVal? "type") == toJson f.op do
      throw s!"{f.id}: source instruction differs"
    let priorIndex := previous.map Frame.sourceIndex
    let sub := if priorIndex == some f.sourceIndex then (previous.map Frame.substep).getD 0 + 1 else 0
    unless priorIndex.all (· ≤ f.sourceIndex) && sub == f.substep &&
        f.id == s!"tsir-{f.sourceId}-{sub}" && f.parents == (previous.map Frame.id).toList do
      throw s!"{f.id}: cycle identity or order differs"
    positions ← (transition nodes edges positions src f).mapError (fun e ↦ s!"{f.id}: {e}")
    previous := some f
  unless (← (← doc.getObjVal? "final").getObjVal? "positions") == toJson positions do
    throw "Final placement differs from the reconstructed rail walk."
  return Json.mkObj [("verified", toJson true), ("cycles", toJson frames.size),
    ("ions", toJson positions.size)]

end QControl.StudioPlacement
