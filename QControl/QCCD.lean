import QControl

/-! A two-site transport lane per ion, with a shared DAC, per-lane selector latch,
    and an independently addressed optical spot at the destination well. -/
namespace QControl.QCCD
open Lean

structure Zone where
  id : String
  wired : Bool
  initialEnable : Bool
  requestEnable : Bool
  arrivalNs : Nat
  deriving ToJson, FromJson

structure Knot where
  offsetNs : Nat
  mv : Nat
  deriving ToJson, FromJson

structure Program where
  kind : String
  version : Nat
  clockNs : Nat
  latchNs : Nat
  settleNs : Nat
  gateNs : Nat
  opticalDelayNs : Nat
  travelUm : Nat
  fullScaleMv : Nat
  gateZone : String
  zones : List Zone
  waveform : List Knot
  deriving ToJson, FromJson

def Program.validate (p : Program) : Except String Unit := do
  unless p.kind == "qccd-broadcast" && p.version == 1 do throw "Unknown QCCD program version."
  unless 0 < p.clockNs && p.clockNs ≤ 1000000 && 0 < p.latchNs && p.latchNs ≤ 1000000 &&
      p.latchNs % p.clockNs == 0 do throw "The latch must lie on a positive receiver clock edge."
  unless 0 < p.settleNs && p.settleNs ≤ 1000000 && 0 < p.gateNs && p.gateNs ≤ 1000000 do
    throw "Settling time and optical pulse width must be positive and at most 1 ms."
  unless p.opticalDelayNs ≤ 1000000 do throw "Optical delivery delay must be at most 1 ms."
  unless 0 < p.travelUm && p.travelUm ≤ 1000 && 0 < p.fullScaleMv && p.fullScaleMv ≤ 10000 do
    throw "Travel must be 1–1000 µm and full scale must be 1–10000 mV."
  unless 0 < p.zones.length && p.zones.length ≤ 6 do throw "Use one to six transport lanes."
  let names := p.zones.map Zone.id
  unless names.Nodup && names.contains p.gateZone do throw "Use unique lanes and an existing optical target."
  for z in p.zones do
    unless z.id.length == 1 && z.id.toList.all (fun c ↦ 'A' ≤ c && c ≤ 'Z') do
      throw "A lane ID must be one uppercase letter."
    unless z.arrivalNs ≤ 2000000 do throw "A selector arrival must be within 2 ms."
  unless 2 ≤ p.waveform.length && p.waveform.length ≤ 32 do throw "Use 2–32 waveform knots."
  unless p.waveform.head?.any (fun k ↦ k.offsetNs == 0 && k.mv == 0) &&
      p.waveform.getLast?.any (fun k ↦ k.mv == p.fullScaleMv) do
    throw "The waveform must start at (0 ns, 0 mV) and finish at full scale."
  for k in p.waveform do
    unless k.mv ≤ p.fullScaleMv && k.offsetNs ≤ 1000000 do throw "Waveform knot exceeds its range."
  unless p.waveform.Pairwise (fun a b ↦ a.offsetNs < b.offsetNs) do
    throw "Waveform knot times must strictly increase."

structure Lane where
  id : String
  wired : Bool
  pending : Bool
  arrived : Bool := false
  latched : Bool
  stale : Bool := false
  electrodeMv : Nat := 0
  ionUm : Nat := 0
  deriving ToJson, DecidableEq, Repr

structure State where
  lanes : List Lane
  issued : Bool := false
  sent : Bool := false
  strobed : Bool := false
  busMv : Nat := 0
  settled : Bool := false
  sourceOn : Bool := false
  lightOn : Bool := false
  exposedIon : Option String := none
  done : Bool := false
  deriving ToJson

def initial (p : Program) : State :=
  { lanes := p.zones.map fun z ↦
      { id := z.id, wired := z.wired, pending := z.initialEnable, latched := z.initialEnable } }

def receive (l : Lane) (bit : Bool) : Lane := { l with pending := bit, arrived := true }
def latch (l : Lane) : Lane := { l with latched := l.pending, stale := !l.arrived }

/-- Quasi-static calibration at knots. A held lane stays in its initial well. -/
def drive (p : Program) (mv : Nat) (l : Lane) : Lane :=
  if l.wired && l.latched then
    { l with electrodeMv := mv, ionUm := mv * p.travelUm / p.fullScaleMv }
  else l

theorem late_write_preserves_latch (l : Lane) (bit : Bool) :
    (receive l bit).latched = l.latched := rfl

theorem held_lane_unchanged (p : Program) (mv : Nat) (l : Lane)
    (h : l.wired = false ∨ l.latched = false) : drive p mv l = l := by
  rcases h with h | h <;> simp [drive, h]

theorem connected_lanes_share_voltage (p : Program) (mv : Nat) (a b : Lane)
    (ha : (a.wired && a.latched) = true) (hb : (b.wired && b.latched) = true) :
    (drive p mv a).electrodeMv = (drive p mv b).electrodeMv := by simp [drive, ha, hb]

inductive Op where
  | issue | transmit | write (z : Zone) | strobe | knot (k : Knot)
  | settle | launch | endLaunch | light | dark | finish

def Op.code : Op → String
  | .issue => "issue" | .transmit => "sendMask" | .write _ => "writeMask"
  | .strobe => "strobe" | .knot _ => "knot" | .settle => "settle"
  | .launch => "launch" | .endLaunch => "endLaunch"
  | .light => "light" | .dark => "dark" | .finish => "finish"

def Op.part : Op → String
  | .issue | .finish => "controller" | .transmit => "fiber"
  | .write z => "zone-" ++ z.id | .strobe => "selector" | .knot _ | .settle => "dac"
  | .light | .dark => "optics"
  | .launch | .endLaunch => "laser"

def step (p : Program) (s : State) : Op → State
  | .issue => { s with issued := true }
  | .transmit => { s with sent := true }
  | .write z => { s with lanes := s.lanes.map fun l ↦
      if l.id == z.id then receive l z.requestEnable else l }
  | .strobe => { s with lanes := s.lanes.map latch, strobed := true }
  | .knot k => { s with busMv := k.mv, lanes := s.lanes.map (drive p k.mv) }
  | .settle => { s with settled := true }
  | .launch => { s with sourceOn := true }
  | .endLaunch => { s with sourceOn := false }
  | .light =>
    let hit := s.lanes.find? fun l ↦ l.id == p.gateZone && l.ionUm == p.travelUm && s.settled
    { s with lightOn := true, exposedIon := hit.map Lane.id }
  | .dark => { s with lightOn := false }
  | .finish => { s with done := true }

/-- A reported optical exposure witnesses a settled ion in the addressed destination well. -/
theorem exposure_has_witness (p : Program) (s : State) (ion : String)
    (h : (step p s .light).exposedIon = some ion) :
    ∃ l ∈ s.lanes, l.id = ion ∧ l.id = p.gateZone ∧ l.ionUm = p.travelUm ∧ s.settled = true := by
  simp only [step] at h
  cases e : s.lanes.find? (fun l ↦ l.id == p.gateZone && l.ionUm == p.travelUm && s.settled) with
  | none => simp [e] at h
  | some l =>
    have ok := List.find?_some e
    simp only [Bool.and_eq_true, beq_iff_eq] at ok
    exact ⟨l, List.mem_of_find?_eq_some e, by simpa [e] using h, ok.1.1, ok.1.2, ok.2⟩

structure Inst where
  id : String
  atNs : Nat
  op : Op
  parents : List String

def instructions (p : Program) : List Inst := Id.run do
  let mut code : Array Inst := #[⟨"issue", 0, .issue, []⟩, ⟨"transmit", 0, .transmit, ["issue"]⟩]
  let mut sampleInputs := #["issue"]
  let mut endInputs := #["dark"]
  let mut lastArrival := 0
  for z in p.zones do
    let id := "write-" ++ z.id
    code := code.push ⟨id, z.arrivalNs, .write z, ["transmit"]⟩
    if z.arrivalNs ≤ p.latchNs then sampleInputs := sampleInputs.push id
    else endInputs := endInputs.push id
    lastArrival := max lastArrival z.arrivalNs
  code := code.push ⟨"strobe", p.latchNs, .strobe, sampleInputs.toList⟩
  let mut cause := "strobe"
  let mut time := p.latchNs
  for (k, i) in p.waveform.zipIdx do
    let id := s!"knot-{i}"
    time := p.latchNs + k.offsetNs
    code := code.push ⟨id, time, .knot k, [cause]⟩
    cause := id
  time := time + p.settleNs
  code := code.push ⟨"settle", time, .settle, [cause]⟩
  code := code.push ⟨"launch", time, .launch, ["settle", "issue"]⟩
  code := code.push ⟨"end-launch", time + p.gateNs, .endLaunch, ["launch"]⟩
  code := code.push ⟨"light", time + p.opticalDelayNs, .light, ["launch"]⟩
  time := time + p.gateNs + p.opticalDelayNs
  code := code.push ⟨"dark", time, .dark, ["light", "end-launch"]⟩
  code := code.push ⟨"finish", max time lastArrival, .finish, endInputs.toList⟩
  return code.toList.mergeSort (fun a b ↦ a.atNs ≤ b.atNs)

/-- Exploded-view layout coordinates. Lane-local ion displacement is separately expressed in µm. -/
structure Node where
  id : String
  label : String
  x : Int
  z : Int
  deriving ToJson

def geometry (p : Program) : List Node :=
  [⟨"controller", "Control FPGA", -144, -55⟩, ⟨"fiber", "Selector data fiber", -97, -40⟩,
   ⟨"selector", "Selector latch", -52, -39⟩, ⟨"dac", "Transport DAC", -52, 17⟩,
   ⟨"laser", "Laser modulator", -53, -81⟩, ⟨"optical-fiber", "Gate-light fiber", 38, -85⟩,
   ⟨"optics", "Optical gate head", 138, -77⟩] ++
  p.zones.zipIdx.map fun (z,i) ↦
    ⟨"zone-" ++ z.id, "Trap lane " ++ z.id, 71, (i : Int) * 43 - (p.zones.length - 1 : Nat) * (21 : Int)⟩

/-- Every opcode is anchored to an assembly. A per-lane write names a lane of the program. -/
theorem instruction_has_geometry (p : Program) (op : Op)
    (bound : ∀ z, op = .write z → z ∈ p.zones) :
    op.part ∈ (geometry p).map Node.id := by
  cases op <;> simp [Op.part, geometry, List.map_map, Function.comp_def]
  case write z =>
    have hz := bound z rfl
    have hm : z ∈ p.zones.zipIdx.map Prod.fst := by simpa using hz
    obtain ⟨⟨w, i⟩, hmem, hw⟩ := List.mem_map.mp hm
    change w = z at hw
    subst w
    repeat apply Or.inr
    exact ⟨z, ⟨i, hmem⟩, rfl⟩

/-- Position of each optical edge along the delivery path, in thousandths of its length. -/
def edgeProgress (start : Option Nat) (now delay : Nat) : Nat :=
  match start with
  | none => 0
  | some t => if delay = 0 then 1000 else min 1000 ((now - t) * 1000 / delay)

structure Frame where
  id : String
  atNs : Nat
  op : String
  part : String
  parents : List String
  targets : List String
  opticalHeadPermille : Nat
  opticalTailPermille : Nat
  state : State
  deriving ToJson

def affected (p : Program) (s : State) : Op → List String
  | .strobe => s.lanes.map (fun l ↦ "zone-" ++ l.id)
  | .knot _ | .settle =>
    (s.lanes.filter (fun l ↦ l.wired && l.latched)).map (fun l ↦ "zone-" ++ l.id)
  | .light | .dark => ["zone-" ++ p.gateZone]
  | .launch | .endLaunch => ["optical-fiber"]
  | _ => []

def run (p : Program) : List Frame := Id.run do
  let mut s := initial p
  let mut frames := #[]
  let mut leading : Option Nat := none
  let mut trailing : Option Nat := none
  for i in instructions p do
    s := step p s i.op
    match i.op with
    | .launch => leading := some i.atNs
    | .endLaunch => trailing := some i.atNs
    | _ => pure ()
    frames := frames.push ⟨i.id, i.atNs, i.op.code, i.op.part, i.parents, affected p s i.op,
      edgeProgress leading i.atNs p.opticalDelayNs, edgeProgress trailing i.atNs p.opticalDelayNs, s⟩
  return frames.toList

end QControl.QCCD
