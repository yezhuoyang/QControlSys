import Lean

/-! Executable semantics of the two-board feed-forward bench. Times are integer nanoseconds,
    voltages are envelope amplitudes in millivolts, and layout coordinates are millimetres. -/
namespace QControl
open Lean

structure Placement where
  x : Int
  z : Int
  deriving ToJson, FromJson, Repr, DecidableEq

structure Program where
  version : Nat
  word : Nat
  readoutNs : Nat
  demodNs : Nat
  linkNs : Nat
  sampleNs : Nat
  clockNs : Nat
  widthNs : Nat
  gapNs : Nat
  tx : Placement
  rx : Placement
  deriving ToJson, FromJson, Repr

/-- The aggregate communication delay includes both transceivers. Drawing positions are schematic. -/
def Program.validate (p : Program) : Except String Unit := do
  unless p.version == 1 do throw "Unknown bench program version."
  unless p.word < 4 do throw "The input must fit in two bits."
  unless p.clockNs > 0 && p.readoutNs > 0 && p.widthNs > 0 do
    throw "Clock period, acquisition window and pulse width must be positive."
  unless p.sampleNs >= 20 && p.sampleNs % p.clockNs == 0 do
    throw "The sample must follow the 20 ns reference marker and lie on a receiver edge."
  unless [p.readoutNs, p.demodNs, p.linkNs, p.sampleNs, p.clockNs, p.widthNs, p.gapNs].all
      (· ≤ 1000000) do throw "Each interval must be at most 1 ms in this bench."
  for board in [p.tx, p.rx] do
    unless board.x.natAbs ≤ 300 && board.z.natAbs ≤ 250 do
      throw "A board is outside the 600 × 500 mm placement area."
  unless (p.tx.x - p.rx.x).natAbs ≥ 160 || (p.tx.z - p.rx.z).natAbs ≥ 112 do
    throw "Board footprints overlap."

/-- Listing 1 of Xu et al. Order of bits in the input word is c[0], c[1] (MSB first). -/
def waveform : Nat → List Nat
  | 1 => [350]
  | 2 => [500, 750]
  | 3 => [500, 750, 750]
  | _ => []

structure Assembly where
  id : String
  label : String
  mount : String
  xMm : Int
  yMm : Int
  zMm : Int
  deriving ToJson

/-- Scene instructions place each active assembly in its parent's local coordinate frame.
    The fiber geometry is routed between the two optical transceivers by the viewer. -/
def assemblies : List Assembly := [
  ⟨"adc", "Readout converter", "tx", -45, 5, 24⟩,
  ⟨"tx-fpga", "Acquisition FPGA", "tx", -15, 5, 0⟩,
  ⟨"tx-port", "Transmit transceiver", "tx", 65, 5, 2⟩,
  ⟨"fiber", "Duplex fiber link", "bench", 0, 0, 0⟩,
  ⟨"rx-port", "Receive transceiver", "rx", -65, 5, 2⟩,
  ⟨"rx-fpga", "Receiver FPGA", "rx", 15, 5, 0⟩,
  ⟨"ram", "Waveform memory", "rx", -9, 5, -31⟩,
  ⟨"dac", "RF output converter", "rx", 45, 5, 24⟩]

inductive Op where
  | acquire | markerOn | markerOff | digitize | classify | pack | transmit | receive
  | sample | lookup | drive | release | finish
  deriving Repr, DecidableEq

def Op.code : Op → String
  | .acquire => "acquire" | .markerOn => "markerOn" | .markerOff => "markerOff"
  | .digitize => "digitize" | .classify => "classify" | .pack => "pack" | .transmit => "transmit"
  | .receive => "receive" | .sample => "sample" | .lookup => "lookup"
  | .drive => "drive" | .release => "release" | .finish => "finish"

/-- Every event is attached to a physical assembly in the scene vocabulary. -/
def Op.part : Op → String
  | .acquire | .digitize => "adc"
  | .classify => "tx-fpga"
  | .pack => "tx-port"
  | .transmit => "fiber"
  | .receive => "rx-port"
  | .sample | .finish => "rx-fpga"
  | .lookup => "ram"
  | .drive | .release | .markerOn | .markerOff => "dac"

theorem every_instruction_has_geometry (op : Op) :
    op.part ∈ assemblies.map Assembly.id := by cases op <;> decide

structure State where
  acquiring : Bool := false
  digitized : Option Nat := none
  classified : Option Nat := none
  packet : Option Nat := none
  inFlight : Option Nat := none
  received : Option Nat := none
  latched : Option Nat := none
  bank : List Nat := []
  marker : Bool := false
  outputMv : Nat := 0
  emitted : Nat := 0
  fault : Bool := false
  done : Bool := false
  deriving ToJson, Repr, DecidableEq

/-- Apply one instruction. An empty register on the sample edge makes the fault sticky. -/
def step (s : State) (op : Op) (arg : Nat := 0) : State :=
  match op with
  | .acquire => { s with acquiring := true }
  | .markerOn => { s with marker := true }
  | .markerOff => { s with marker := false }
  | .digitize => { s with acquiring := false, digitized := some arg }
  | .classify => { s with classified := s.digitized }
  | .pack => { s with packet := s.classified }
  | .transmit => { s with inFlight := s.packet }
  | .receive => { s with received := s.inFlight, inFlight := none }
  | .sample => { s with latched := s.received, fault := s.fault || s.received.isNone }
  | .lookup => { s with bank := s.latched.elim [] waveform }
  | .drive =>
    if s.fault then s else
      match s.bank[arg]? with
      | none => s
      | some mv => { s with outputMv := mv, emitted := s.emitted + 1 }
  | .release => { s with outputMv := 0 }
  | .finish => { s with done := true }

theorem missing_sample_faults (s : State) (h : s.received = none) :
    (step s .sample).fault = true := by simp [step, h]

theorem on_time_sample (s : State) (v : Nat) (h : s.received = some v) :
    (step s .sample).latched = some v := by simp [step, h]

theorem fault_blocks_drive (s : State) (i : Nat) (h : s.fault = true) :
    step s .drive i = s := by simp [step, h]

theorem fault_persists (s : State) (op : Op) (a : Nat) (h : s.fault = true) :
    (step s op a).fault = true := by cases op <;> simp [step, h]

theorem fault_preserves_count (s : State) (op : Op) (a : Nat) (h : s.fault = true) :
    (step s op a).emitted = s.emitted := by cases op <;> simp [step, h]

/-- After a missed sample, even an arbitrary suffix of instructions cannot emit another pulse. -/
theorem inhibited_suffix (ops : List (Op × Nat)) (s : State) (h : s.fault = true) :
    (ops.foldl (fun st cmd ↦ step st cmd.1 cmd.2) s).emitted = s.emitted := by
  induction ops generalizing s with
  | nil => rfl
  | cons cmd rest ih =>
    simp only [List.foldl_cons]
    exact (ih _ (fault_persists s cmd.1 cmd.2 h)).trans (fault_preserves_count s cmd.1 cmd.2 h)

structure Instruction where
  id : String
  atNs : Nat
  op : Op
  parents : List String
  arg : Nat := 0

structure Frame where
  id : String
  atNs : Nat
  op : String
  part : String
  parents : List String
  arg : Nat
  state : State
  deriving ToJson

def execute (initial : State) (code : List Instruction) : List Frame := Id.run do
  let mut s := initial
  let mut frames := #[]
  for i in code do
    s := step s i.op i.arg
    frames := frames.push ⟨i.id, i.atNs, i.op.code, i.op.part, i.parents, i.arg, s⟩
  return frames.toList

def prefixCode (p : Program) : List Instruction := Id.run do
  let classifyTime := p.readoutNs + p.demodNs
  let arrival := classifyTime + p.linkNs
  let inputs := if arrival ≤ p.sampleNs then ["marker-on", "receive"] else ["marker-on"]
  let code : List Instruction := [
    ⟨"acquire", 0, .acquire, [], 0⟩,
    ⟨"marker-on", 0, .markerOn, [], 0⟩,
    ⟨"marker-off", 20, .markerOff, ["marker-on"], 0⟩,
    ⟨"digitize", p.readoutNs, .digitize, ["acquire"], p.word⟩,
    ⟨"classify", classifyTime, .classify, ["digitize"], 0⟩,
    ⟨"pack", classifyTime, .pack, ["classify"], 0⟩,
    ⟨"transmit", classifyTime, .transmit, ["pack"], 0⟩,
    ⟨"receive", arrival, .receive, ["transmit"], 0⟩,
    ⟨"sample", p.sampleNs, .sample, inputs, 0⟩]
  -- Stable sorting preserves the specified microstep order at equal timestamp.
  return code.mergeSort (fun a b ↦ a.atNs ≤ b.atNs)

def run (p : Program) : List Frame := Id.run do
  let head := execute {} (prefixCode p)
  let s := (head.getLast?).map (·.state) |>.getD {}
  let mut tail := #[]
  let mut lastTime := max p.sampleNs (p.readoutNs + p.demodNs + p.linkNs)
  let mut lastIds := if s.fault then ["sample", "receive"] else ["sample"]
  if !s.fault then
    tail := tail.push ⟨"lookup", p.sampleNs, .lookup, ["sample"], 0⟩
    let selected := (step s .lookup).bank
    lastIds := ["lookup"]
    for i in [:selected.length] do
      let start := p.sampleNs + i * (p.widthNs + p.gapNs)
      let id := s!"pulse-{i}"
      let endId := s!"release-{i}"
      tail := tail.push ⟨id, start, .drive, lastIds, i⟩
      lastTime := start + p.widthNs
      tail := tail.push ⟨endId, lastTime, .release, [id], i⟩
      lastIds := [endId]
  tail := tail.push ⟨"finish", lastTime, .finish, lastIds, 0⟩
  return head ++ execute s tail.toList

end QControl
