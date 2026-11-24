/-! Timing contracts of the RISC-Q converter-edge datapath, with their proofs.

    The control core never drives a converter directly. It writes a pulse-table entry and a
    `startTime`, then fires. A timed queue next to the converter holds the entry and releases
    it `lead` cycles early, so the parameter reaches the converter on cycle `startTime`. The
    theorems below state when that holds and what happens when a write arrives too late.

    Units: every time is a count of dspClk cycles. One cycle carries one batch of converter
    samples (16 DAC samples or 4 ADC samples). The batch-time register is 32 bits wide.
    Boundary: this is the timing contract, taken from the RTL and its simulations. Carrier
    synthesis (CORDIC, complex multiply) is represented by its latency only.
    Evidence: RISC-Q `src/riscq/dsp/pulse/TimedQueue.scala` (RegHead implementation),
    `src/riscq/soc/rf/PulseParamBuffer.scala`, `docs/dsp/PulseGenerator.md`. -/
namespace QControl.RiscQ

/-- Pipeline latencies of the default pulse generator (`prescaleAmp`, no saturation,
    16-bit data, memory latency 2). `docs/dsp/PulseGenerator.md`, "Latency". -/
structure Datapath where
  complexMul : Nat := 6
  gate : Nat := 1
  carrierAmp : Nat := 27
  carrierPhase : Nat := 28
  carrierFreq : Nat := 29
  phasor : Nat := 8
  envelopeReader : Nat := 4
  cordic : Nat := 19

namespace Datapath
def leadAmp (d : Datapath) := d.carrierAmp + d.complexMul + d.gate
def leadPhase (d : Datapath) := d.carrierPhase + d.complexMul + d.gate
def leadFreqCarrier (d : Datapath) := d.carrierFreq + d.complexMul + d.gate
/-- Phasors are regenerated serially, one lane per cycle, through one CORDIC. -/
def regenCycles (d : Datapath) (lanes : Nat) := lanes + d.cordic + 2
def leadFreqPhasor (d : Datapath) (lanes : Nat) := d.regenCycles lanes + d.phasor + d.complexMul + d.gate
def leadAddr (d : Datapath) := d.envelopeReader + d.complexMul + d.gate
def leadDur (d : Datapath) := d.gate + 1
end Datapath

/-- The derived leads equal the constants RISC-Q reports for a 16-lane DAC channel. -/
theorem default_leads :
    let d : Datapath := {}
    (d.leadAmp, d.leadPhase, d.leadFreqCarrier, d.leadFreqPhasor 16, d.leadAddr, d.leadDur)
      = (34, 35, 36, 52, 11, 2) := by decide

/-- The slowest parameter of a fired pulse is its phase. -/
theorem phase_is_slowest_fired_lead :
    let d : Datapath := {}
    d.leadAmp ≤ d.leadPhase ∧ d.leadAddr ≤ d.leadPhase ∧ d.leadDur ≤ d.leadPhase := by decide

/-- Cycles from a FIFO push to the earliest pop: FIFO write, head register, registered compare. -/
def pushMargin : Nat := 3

/-- A queue pops at most every other cycle. The fire-once blank costs one cycle. -/
def popInterval : Nat := 2

/-- Cycles until the registered due test `signed(time − (startTime − lead)) ≥ 0` first holds,
    counted from a cycle whose time register reads `reg`. The test wraps at 2³². A target
    more than 2³¹ behind reads as due, and one more than 2³¹ ahead also reads as due. -/
def dueWait (reg startTime lead : Nat) : Nat :=
  let d := (startTime % 4294967296 + 4294967296 - (reg + lead) % 4294967296) % 4294967296
  if d = 0 ∨ d > 2147483648 then 0 else d

/-- First cycle at which an entry can pop: after its own push margin and after the blank
    that follows the previous pop of the same queue. -/
def readyCycle (push : Nat) (prev : Option Nat) : Nat :=
  max (push + pushMargin) (match prev with | some q => q + popInterval | none => 0)

/-- Cycle at which a queue entry pops. `offset` is the time register's value at cycle 0. -/
def popCycle (offset push startTime lead : Nat) (prev : Option Nat) : Nat :=
  let ready := readyCycle push prev
  ready + dueWait (ready + offset) startTime lead

/-- Cycle at which the popped parameter takes effect at the converter. -/
def landCycle (offset push startTime lead : Nat) (prev : Option Nat) : Nat :=
  popCycle offset push startTime lead prev + lead

theorem popCycle_ge_ready (offset push startTime lead : Nat) (prev : Option Nat) :
    readyCycle push prev ≤ popCycle offset push startTime lead prev := by
  simp [popCycle]

/-- An entry never pops sooner than three cycles after its push. -/
theorem popCycle_ge_push (offset push startTime lead : Nat) (prev : Option Nat) :
    push + pushMargin ≤ popCycle offset push startTime lead prev := by
  have h := popCycle_ge_ready offset push startTime lead prev
  have : push + pushMargin ≤ readyCycle push prev := by simp [readyCycle]; omega
  omega

/-- Consecutive pops of one queue are at least two cycles apart. -/
theorem popCycle_spacing (offset push startTime lead q : Nat) :
    q + popInterval ≤ popCycle offset push startTime lead (some q) := by
  have h := popCycle_ge_ready offset push startTime lead (some q)
  have : q + popInterval ≤ readyCycle push (some q) := by simp [readyCycle]; omega
  omega

/-- **Lead-time scheduling.** If the entry is ready no later than `lead` cycles before its
    start time, and the start time is less than 2³¹ cycles away, the parameter lands exactly
    when the time register reads `startTime`. The arrival cycle does not appear in the result. -/
theorem land_exact (offset push startTime lead : Nat) (prev : Option Nat)
    (onTime : readyCycle push prev + offset + lead ≤ startTime)
    (near : startTime ≤ readyCycle push prev + offset + lead + 2147483648) :
    landCycle offset push startTime lead prev + offset = startTime := by
  unfold landCycle popCycle dueWait
  generalize readyCycle push prev = ready at *
  simp only
  split <;> omega

/-- Two writes that both meet the margin produce the same converter cycle, whatever the
    link latency that separates them. This is why the posted link can be pipelined freely. -/
theorem land_independent_of_arrival (offset push push' startTime lead : Nat) (prev prev' : Option Nat)
    (onTime : readyCycle push prev + offset + lead ≤ startTime)
    (near : startTime ≤ readyCycle push prev + offset + lead + 2147483648)
    (onTime' : readyCycle push' prev' + offset + lead ≤ startTime)
    (near' : startTime ≤ readyCycle push' prev' + offset + lead + 2147483648) :
    landCycle offset push startTime lead prev = landCycle offset push' startTime lead prev' := by
  have a := land_exact offset push startTime lead prev onTime near
  have b := land_exact offset push' startTime lead prev' onTime' near'
  omega

/-- A write that misses the margin by less than 2³¹ cycles pops as soon as it is ready and
    lands late by exactly the amount it missed. -/
theorem land_late (offset push startTime lead : Nat) (prev : Option Nat)
    (missed : startTime < readyCycle push prev + offset + lead)
    (near : readyCycle push prev + offset + lead < startTime + 2147483648) :
    landCycle offset push startTime lead prev = readyCycle push prev + lead := by
  unfold landCycle popCycle dueWait
  generalize readyCycle push prev = ready at *
  simp only
  split <;> omega

/-- One pulse-table entry. Fields are the 16-bit codes carried in bits 31:16 of a put. -/
structure Slot where
  phase : Nat := 0
  amp : Nat := 0
  env : Nat := 0
  dur : Nat := 0
  deriving Repr, BEq, Inhabited

/-- Register file of one channel at the converter edge. -/
structure Buffer where
  startTime : Nat := 0
  freq : Nat := 0
  dcOffset : Nat := 0
  phaseOffset : Nat := 0
  table : Array Slot := #[]
  deriving Repr, Inhabited

inductive Field where | phase | amp | env | dur
  deriving Repr, DecidableEq, Inhabited

/-- One posted register write, decoded by address. -/
inductive Cmd where
  | fire (slot : Nat)
  | setFreq (code : Nat)
  | setDcOffset (code : Nat)
  | setPhaseOffset (code : Nat)
  | setField (slot : Nat) (field : Field) (code : Nat)
  | setStart (time : Nat)
  | unmapped
  deriving Repr, DecidableEq, Inhabited

/-- Smallest `n` with `2ⁿ ≥ x`, as SpinalHDL's `log2Up`. -/
def log2Up (x : Nat) : Nat := Nat.log2 (2 * x - 1)

/-- Address decode of `PulseParamBuffer`. `offset` is relative to the channel window and
    `data` is the 32-bit put word. `envBits` is the envelope address width. Slot 0 of the
    16-byte grid holds the scalar registers. Entry `i` occupies slot `i + 1`. -/
def decodeCmd (slots envBits offset data : Nat) : Cmd :=
  let field := data / 65536 % 65536
  if offset = 0x4100 then .setStart (data % 4294967296)
  else if offset / 16 = 0 then
    if offset = 0 then .fire (data % 2 ^ log2Up slots)
    else if offset = 4 then .setFreq field
    else if offset = 8 then .setDcOffset field
    else if offset = 12 then .setPhaseOffset field
    else .unmapped
  else if offset / 16 ≤ slots then
    if offset % 16 = 0 then .setField (offset / 16 - 1) .phase field
    else if offset % 16 = 4 then .setField (offset / 16 - 1) .amp field
    else if offset % 16 = 8 then .setField (offset / 16 - 1) .env (field % 2 ^ envBits)
    else if offset % 16 = 12 then .setField (offset / 16 - 1) .dur field
    else .unmapped
  else .unmapped

/-- What a fire hands to the timed queues: the entry and the start time it captured. -/
structure Fired where
  slot : Nat
  entry : Slot
  startTime : Nat
  deriving Repr, BEq, Inhabited

/-- Apply one posted write. Writes take effect in arrival order. A fire captures the start
    time of its own beat, then advances the register by the fired entry's duration. -/
def Buffer.apply (b : Buffer) : Cmd → Buffer × Option Fired
  | .fire slot =>
    let entry := b.table[slot]?.getD {}
    ({ b with startTime := (b.startTime + entry.dur) % 4294967296 }, some ⟨slot, entry, b.startTime⟩)
  | .setFreq code => ({ b with freq := code }, none)
  | .setDcOffset code => ({ b with dcOffset := code }, none)
  | .setPhaseOffset code => ({ b with phaseOffset := code }, none)
  | .setField slot field code =>
    let entry := b.table[slot]?.getD {}
    let entry := match field with
      | .phase => { entry with phase := code } | .amp => { entry with amp := code }
      | .env => { entry with env := code } | .dur => { entry with dur := code }
    ({ b with table := if slot < b.table.size then b.table.set! slot entry else b.table }, none)
  | .setStart time => ({ b with startTime := time }, none)
  | .unmapped => (b, none)

/-- A fire schedules its entry at the buffer's current start time. -/
theorem fire_captures_start (b : Buffer) (slot : Nat) :
    ((b.apply (.fire slot)).2.map Fired.startTime) = some b.startTime := by
  simp [Buffer.apply]

/-- **Back-to-back trains.** A second fire is scheduled exactly one duration after the first,
    with no time arithmetic in the control program. -/
theorem fire_fire_contiguous (b : Buffer) (first second : Nat) :
    (((b.apply (.fire first)).1.apply (.fire second)).2.map Fired.startTime)
      = some ((b.startTime + (b.table[first]?.getD {}).dur) % 4294967296) := by
  simp [Buffer.apply]

/-- **An explicit start time wins.** Writing `startTime` after a fire discards the advance. -/
theorem explicit_start_wins (b : Buffer) (slot time : Nat) :
    ((b.apply (.fire slot)).1.apply (.setStart time)).1.startTime = time := by
  simp [Buffer.apply]

/-- A fire changes no table entry, so a slot can be fired repeatedly. -/
theorem fire_preserves_table (b : Buffer) (slot : Nat) :
    (b.apply (.fire slot)).1.table = b.table := by
  simp [Buffer.apply]

private theorem decode_slot (slots envBits offset data i : Nat) (inRange : i < slots)
    (slot : offset / 16 = i + 1) (notStart : offset ≠ 0x4100) :
    decodeCmd slots envBits offset data =
      (if offset % 16 = 0 then .setField i .phase (data / 65536 % 65536)
       else if offset % 16 = 4 then .setField i .amp (data / 65536 % 65536)
       else if offset % 16 = 8 then .setField i .env (data / 65536 % 65536 % 2 ^ envBits)
       else if offset % 16 = 12 then .setField i .dur (data / 65536 % 65536)
       else .unmapped) := by
  have within : i + 1 ≤ slots := by omega
  simp [decodeCmd, slot, notStart, within]

/-- The register layout that firmware writes: `startTime` at 0x4100 and the fields of
    entry `i` at `(i + 1) · 16`. The table must end below the start-time register, as the
    RTL requires. -/
theorem decode_layout (slots envBits data i : Nat) (inRange : i < slots)
    (fits : (slots + 1) * 16 ≤ 0x4100) :
    decodeCmd slots envBits 0x4100 data = .setStart (data % 4294967296) ∧
    decodeCmd slots envBits ((i + 1) * 16) data = .setField i .phase (data / 65536 % 65536) ∧
    decodeCmd slots envBits ((i + 1) * 16 + 4) data = .setField i .amp (data / 65536 % 65536) ∧
    decodeCmd slots envBits ((i + 1) * 16 + 12) data = .setField i .dur (data / 65536 % 65536) := by
  refine ⟨by simp [decodeCmd], ?_, ?_, ?_⟩
  · rw [decode_slot slots envBits _ data i inRange (by omega) (by omega)]
    have m : (i + 1) * 16 % 16 = 0 := by omega
    simp [m]
  · rw [decode_slot slots envBits _ data i inRange (by omega) (by omega)]
    have m : ((i + 1) * 16 + 4) % 16 = 4 := by omega
    simp [m]
  · rw [decode_slot slots envBits _ data i inRange (by omega) (by omega)]
    have m : ((i + 1) * 16 + 12) % 16 = 12 := by omega
    simp [m]

end QControl.RiscQ
