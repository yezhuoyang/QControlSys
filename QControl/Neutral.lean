import QControl

/-! Two crossed, multitone acousto-optic deflectors generate a Cartesian tweezer array.
    Row/column motion and preservation of order follow the transport protocol of
    [Bluvstein et al.](https://doi.org/10.1038/s41586-022-04592-6). The narrow-band
    affine position calibration and finite acoustic response reflect the deflection
    and aperture relations in [Isomet's application note](https://isomet.com/App-Manual_pdf/RFA3110-4%28BS%29_rev4.pdf).
    Version 1 approximates each tone ramp by integer-kHz, zero-order-held updates
    and replaces the distributed acoustic response by a common pure delay. Atoms
    stay at the delivered trap centers. Optical power, aperture transients, motional
    excitation, losses and quantum dynamics are outside this positional model.
    The example frequencies, slope, timing and scene layout are illustrative. -/
namespace QControl.Neutral
open Lean

inductive Axis where
  | x | y
  deriving DecidableEq, FromJson, ToJson

structure Atom where
  id : String
  column : Nat
  row : Nat
  deriving FromJson, ToJson

structure Move where
  id : String
  axis : Axis
  tone : Nat
  targetKHz : Nat
  startNs : Nat
  durationNs : Nat
  steps : Nat
  deriving FromJson, ToJson

structure Program where
  kind : String
  version : Nat
  clockNs : Nat
  acousticNs : Nat
  referenceKHz : Nat
  nmPerKHz : Nat
  columnsKHz : List Nat
  rowsKHz : List Nat
  atoms : List Atom
  moves : List Move
  deriving FromJson, ToJson

structure Axes (α : Type) where
  x : α
  y : α

def Axes.read (a : Axes α) : Axis → α
  | .x => a.x
  | .y => a.y

def Axes.write (a : Axes α) (axis : Axis) (v : α) : Axes α :=
  match axis with
  | .x => { a with x := v }
  | .y => { a with y := v }

abbrev Tones := Axes (List Nat)

def setTone (t : Tones) (axis : Axis) (tone frequency : Nat) : Tones :=
  t.write axis ((t.read axis).set tone frequency)

def Program.tones (p : Program) : Tones := ⟨p.columnsKHz, p.rowsKHz⟩

private def validFrequency (f : Nat) : Bool := 0 < f && f ≤ 1000000

private def validId (id : String) : Bool :=
  0 < id.length && id.length ≤ 32 && id.toList.all
    (fun c ↦ c.isAlphanum || c == '-' || c == '_')

def Program.validate (p : Program) : Except String Unit := do
  unless p.kind == "neutral-aod" && p.version == 1 do throw "Unknown neutral-atom program version."
  unless 0 < p.clockNs && p.clockNs ≤ 1000000 && 0 < p.acousticNs && p.acousticNs ≤ 1000000 do
    throw "Clock period and acoustic delay must be 1–1000000 ns."
  unless validFrequency p.referenceKHz && 0 < p.nmPerKHz && p.nmPerKHz ≤ 1000 do
    throw "Use a reference of 1–1000000 kHz and a positive slope of at most 1000 nm/kHz."
  for a in [p.columnsKHz, p.rowsKHz] do
    unless 0 < a.length && a.length ≤ 4 && a.all validFrequency && a.Pairwise (· < ·) do
      throw "Each axis needs 1–4 strictly increasing tones in 1–1000000 kHz."
  unless p.atoms.length ≤ p.columnsKHz.length * p.rowsKHz.length &&
      (p.atoms.map Atom.id).Nodup && (p.atoms.map fun a ↦ (a.column, a.row)).Nodup do
    throw "Atom IDs and occupied intersections must be unique."
  for a in p.atoms do
    unless validId a.id && a.column < p.columnsKHz.length && a.row < p.rowsKHz.length do
      throw "Each atom needs a valid ID and an existing column and row."
  unless p.moves.length ≤ 8 && (p.moves.map Move.steps).sum ≤ 32 &&
      (p.moves.map Move.id).Nodup && p.moves.Pairwise (fun a b ↦ a.startNs ≤ b.startNs) do
    throw "Use up to eight uniquely named moves in start-time order and up to 32 RF updates in total."
  let mut tones := p.tones
  let mut freeAt : Axes Nat := ⟨0, 0⟩
  for m in p.moves do
    unless validId m.id && m.tone < (tones.read m.axis).length && validFrequency m.targetKHz do
      throw s!"Move {m.id} needs a valid ID, an existing tone and a target in 1–1000000 kHz."
    unless 0 < m.steps && 0 < m.durationNs && m.startNs + m.durationNs ≤ 1000000000 &&
        m.startNs % p.clockNs == 0 && m.durationNs % (p.clockNs * m.steps) == 0 do
      throw s!"Move {m.id} must use equally spaced, positive clock intervals and finish within 1 s."
    unless freeAt.read m.axis ≤ m.startNs do throw s!"Move {m.id} overlaps a ramp on the same axis."
    tones := setTone tones m.axis m.tone m.targetKHz
    unless (tones.read m.axis).Pairwise (· < ·) do throw s!"Move {m.id} would merge or cross tones."
    freeAt := freeAt.write m.axis (m.startNs + m.durationNs)

structure Machine where
  rf : Tones
  delivered : Tones
  issued : Nat := 0
  done : Bool := false

inductive Op where
  | issue (m : Move)
  | rf (m : Move) (frequencyKHz : Nat)
  | deliver (m : Move) (frequencyKHz : Nat)
  | finish

def step (s : Machine) : Op → Machine
  | .issue _ => { s with issued := s.issued + 1 }
  | .rf m f => { s with rf := setTone s.rf m.axis m.tone f }
  | .deliver m f => { s with delivered := setTone s.delivered m.axis m.tone f }
  | .finish => { s with done := true }

def positionNm (p : Program) (f : Nat) : Int :=
  ((f : Int) - (p.referenceKHz : Int)) * (p.nmPerKHz : Int)

/-- A positive affine calibration preserves the order of distinct tone frequencies. -/
theorem position_increases (p : Program) (a b : Nat) (h : a < b) (slope : 0 < p.nmPerKHz) :
    positionNm p a < positionNm p b :=
  Int.mul_lt_mul_of_pos_right (Int.sub_lt_sub_right (Int.ofNat_lt.mpr h) _)
    (Int.ofNat_lt.mpr slope)

def coordinate (p : Program) (s : Machine) (axis : Axis) (tone : Nat) : Int :=
  positionNm p ((s.delivered.read axis)[tone]?.getD p.referenceKHz)

structure PlacedAtom extends Atom where
  xNm : Int
  yNm : Int
  deriving ToJson

def place (p : Program) (s : Machine) (a : Atom) : PlacedAtom :=
  { toAtom := a, xNm := coordinate p s .x a.column, yNm := coordinate p s .y a.row }

/-- Any two atoms on the same column share the projected x coordinate in every machine state. -/
theorem column_shared (p : Program) (s : Machine) (a b : Atom) (h : a.column = b.column) :
    (place p s a).xNm = (place p s b).xNm := by simp [place, h]

/-- Any two atoms on the same row share the projected y coordinate in every machine state. -/
theorem row_shared (p : Program) (s : Machine) (a b : Atom) (h : a.row = b.row) :
    (place p s a).yNm = (place p s b).yNm := by simp [place, h]

/-- Writing a DDS sample alone changes no projected atom position. -/
theorem rf_preserves_atoms (p : Program) (s : Machine) (a : Atom) (m : Move) (f : Nat) :
    place p (step s (.rf m f)) a = place p s a := rfl

/-- Acoustic delivery leaves coordinates on the other deflector unchanged. -/
theorem orthogonal_axis_unchanged (p : Program) (s : Machine) (axis : Axis)
    (m : Move) (f i : Nat) (h : axis ≠ m.axis) :
    coordinate p (step s (.deliver m f)) axis i = coordinate p s axis i := by
  cases axis <;> cases ha : m.axis <;> simp_all [coordinate, step, setTone, Axes.read, Axes.write]

/-- Acoustic delivery leaves every other tone on the same deflector unchanged. -/
theorem other_tone_unchanged (p : Program) (s : Machine) (m : Move) (f i : Nat) (h : i ≠ m.tone) :
    coordinate p (step s (.deliver m f)) m.axis i = coordinate p s m.axis i := by
  cases ha : m.axis <;> simp [coordinate, step, setTone, Axes.read, Axes.write, ha, Ne.symm h]

/-- An in-range delivery sets the projected coordinate to the calibration of its RF value. -/
theorem addressed_tone_delivered (p : Program) (s : Machine) (m : Move) (f : Nat)
    (h : m.tone < (s.delivered.read m.axis).length) :
    coordinate p (step s (.deliver m f)) m.axis m.tone = positionNm p f := by
  cases ha : m.axis <;> simp_all [coordinate, step, setTone, Axes.read, Axes.write]

structure Trap where
  id : String
  column : Nat
  row : Nat
  xNm : Int
  yNm : Int
  atom : Option String
  deriving ToJson

structure State where
  rfXKHz : List Nat
  rfYKHz : List Nat
  deliveredXKHz : List Nat
  deliveredYKHz : List Nat
  issued : Nat
  done : Bool
  traps : List Trap
  atoms : List PlacedAtom
  deriving ToJson

def snapshot (p : Program) (s : Machine) : State :=
  let traps := (List.range p.columnsKHz.length).flatMap fun c ↦
    (List.range p.rowsKHz.length).map fun r ↦
      let atom := p.atoms.find? fun a ↦ a.column == c && a.row == r
      (⟨s!"trap-{c}-{r}", c, r, coordinate p s .x c, coordinate p s .y r, atom.map Atom.id⟩ : Trap)
  ⟨s.rf.x, s.rf.y, s.delivered.x, s.delivered.y, s.issued, s.done, traps, p.atoms.map (place p s)⟩

/-- Every addressable intersection has a trap in every snapshot, independent of loading. -/
theorem all_intersections_visible (p : Program) (s : Machine) (c r : Nat)
    (hc : c < p.columnsKHz.length) (hr : r < p.rowsKHz.length) :
    ∃ t ∈ (snapshot p s).traps, t.column = c ∧ t.row = r := by
  refine ⟨_, List.mem_flatMap.mpr ⟨c, List.mem_range.mpr hc,
    List.mem_map.mpr ⟨r, List.mem_range.mpr hr, rfl⟩⟩, rfl, rfl⟩

def initialMachine (p : Program) : Machine := { rf := p.tones, delivered := p.tones }

def initial (p : Program) : State := snapshot p (initialMachine p)

structure Inst where
  id : String
  atNs : Nat
  op : Op
  parents : List String

/-- Floor the weighted mean in kHz. Index k runs from 1 through m.steps. -/
def rampFrequency (start target steps k : Nat) : Nat := ((steps - k) * start + k * target) / steps

/-- The final integer-frequency sample reaches its target exactly. -/
theorem ramp_endpoint (start target steps : Nat) (h : 0 < steps) :
    rampFrequency start target steps steps = target := by simp [rampFrequency, h]

/-- Every sampled ramp stays between any common bounds on its endpoints. Thus
    checking endpoints against stationary neighboring tones also bounds every knot. -/
theorem ramp_bounded (start target steps k lo hi : Nat) (hs : 0 < steps) (hk : k ≤ steps)
    (ls : lo ≤ start) (ltg : lo ≤ target) (sh : start ≤ hi) (th : target ≤ hi) :
    lo ≤ rampFrequency start target steps k ∧ rampFrequency start target steps k ≤ hi := by
  have sum : steps - k + k = steps := Nat.sub_add_cancel hk
  constructor
  · apply (Nat.le_div_iff_mul_le hs).mpr
    calc
      lo * steps = (steps - k) * lo + k * lo := by rw [← Nat.add_mul, sum, Nat.mul_comm]
      _ ≤ (steps - k) * start + k * target :=
        Nat.add_le_add (Nat.mul_le_mul_left _ ls) (Nat.mul_le_mul_left _ ltg)
  · apply Nat.div_le_of_le_mul
    calc
      (steps - k) * start + k * target ≤ (steps - k) * hi + k * hi :=
        Nat.add_le_add (Nat.mul_le_mul_left _ sh) (Nat.mul_le_mul_left _ th)
      _ = steps * hi := by rw [← Nat.add_mul, sum]

def instructions (p : Program) : List Inst := Id.run do
  let mut code : Array Inst := #[]
  let mut programmed := p.tones
  let mut lastRf : Axes (Option String) := ⟨none, none⟩
  let mut lastDelivery : Axes (Option String) := ⟨none, none⟩
  let mut lastIssue : Option String := none
  let mut endNs := 0
  for m in p.moves do
    let issue := m.id ++ "-issue"
    let start := (programmed.read m.axis)[m.tone]?.getD p.referenceKHz
    code := code.push ⟨issue, m.startNs, .issue m, lastIssue.toList ++ (lastRf.read m.axis).toList⟩
    lastIssue := some issue
    let mut rfCause := issue
    for n in List.range m.steps do
      let k := n + 1
      let freq := rampFrequency start m.targetKHz m.steps k
      let atNs := m.startNs + k * (m.durationNs / m.steps)
      let rf := s!"{m.id}-rf-{k}"
      let delivery := s!"{m.id}-deliver-{k}"
      code := code.push ⟨rf, atNs, .rf m freq, [rfCause]⟩
      code := code.push ⟨delivery, atNs + p.acousticNs, .deliver m freq,
        rf :: (lastDelivery.read m.axis).toList⟩
      rfCause := rf
      lastDelivery := lastDelivery.write m.axis (some delivery)
      endNs := max endNs (atNs + p.acousticNs)
    lastRf := lastRf.write m.axis (some rfCause)
    programmed := setTone programmed m.axis m.tone m.targetKHz
  code := code.push ⟨"finish", endNs, .finish, lastDelivery.x.toList ++ lastDelivery.y.toList⟩
  return code.toList.mergeSort (fun a b ↦ a.atNs ≤ b.atNs)

structure Node where
  id : String
  label : String
  x : Int
  z : Int
  deriving ToJson

/-- Exploded assembly coordinates in schematic mm. Physical trap-plane coordinates are signed nm. -/
def geometry (_p : Program) : List Node :=
  [⟨"controller", "Control FPGA", -115, 35⟩, ⟨"dds", "Multitone DDS / RF drive", -65, 35⟩,
   ⟨"aod-x", "Column deflector", -65, -25⟩, ⟨"aod-y", "Row deflector", -15, -25⟩,
   ⟨"array", "Objective and atom plane", 88, 0⟩]

def Axis.part : Axis → String
  | .x => "aod-x" | .y => "aod-y"

def Op.code : Op → String
  | .issue _ => "issue" | .rf .. => "rf" | .deliver .. => "deliver" | .finish => "finish"

def Op.part : Op → String
  | .issue _ | .finish => "controller" | .rf .. => "dds" | .deliver m _ => m.axis.part

def Op.targets : Op → List String
  | .issue _ => ["dds"] | .rf m _ => [m.axis.part] | .deliver .. => ["array"] | .finish => []

/-- Every operation has a physical assembly in the serialized scene. -/
theorem instruction_has_geometry (p : Program) (op : Op) : op.part ∈ (geometry p).map Node.id := by
  cases op <;> simp [Op.part, geometry]
  case deliver m f => cases m.axis <;> decide

structure Frame where
  id : String
  atNs : Nat
  op : String
  part : String
  parents : List String
  targets : List String
  axis : Option Axis
  tone : Option Nat
  frequencyKHz : Option Nat
  state : State
  deriving ToJson

def frame (p : Program) (i : Inst) (s : Machine) : Frame :=
  let move := match i.op with
    | .issue m | .rf m _ | .deliver m _ => some m
    | .finish => none
  let frequency := match i.op with
    | .rf _ f | .deliver _ f => some f
    | _ => none
  ⟨i.id, i.atNs, i.op.code, i.op.part, i.parents, i.op.targets,
   move.map Move.axis, move.map Move.tone, frequency, snapshot p s⟩

def run (p : Program) : List Frame := Id.run do
  let mut s := initialMachine p
  let mut frames := #[]
  for i in instructions p do
    s := step s i.op
    frames := frames.push (frame p i s)
  return frames.toList

end QControl.Neutral
