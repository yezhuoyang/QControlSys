import Lean
import QControl.RiscQ.Rv32
import QControl.RiscQ.Timing
import QControl.RiscQ.Pipe
import QControl.RiscQ.Heap

/-! Executable model of a RISC-Q system-on-chip.

    Each core runs RV32I firmware out of its own RAM. A store into the put window becomes a
    posted register write that travels a pipelined link to one channel at the converter edge.
    The channel holds a pulse table and timed queues. A fire releases its entry at the
    scheduled batch, which opens a pulse window on a DAC, a demodulation window on an ADC, or
    updates sixteen digital lines. Reports travel back to core-local sinks that firmware reads.
    A board hub provides shared bits, counted barriers and mailboxes between cores.

    Execution is a discrete-event simulation with exact cycle arithmetic. Every event is one
    trace frame with a stable ID, the scene part it acts on, its causal parents and the
    committed state of that part. At equal cycles, converter-edge and link events apply before
    a core retires an instruction, and cores retire in index order.

    Units: `atBatch` counts dspClk cycles from reset release. `atPs = atBatch · dspPeriodPs`.
    Boundaries, each also listed in `docs/riscq-controller.md`:
    * Core timing is the cycle model of RISC-Q's pipeline in `QControl.RiscQ.Pipe` (fetch ring,
      branch prediction, interlock, store buffer, data-bus latencies), checked instruction by
      instruction against RISC-Q's RTL in Verilator. Converter timing does not depend on it
      while the lead-time margin holds (`land_exact`).
    * Carrier synthesis is its latency. A pulse frame reports the scheduled codes.
    * No quantum state. Readout results and digital input edges are supplied by the program.
    * Link, hub and report latencies are parameters with RISC-Q's documented stage counts. -/
namespace QControl.RiscQ
open Lean

structure ChannelSpec where
  name : String
  kind : String
  slots : Nat
  envDepth : Nat
  interp : Nat
  dac? : Option Nat := none
  adc? : Option Nat := none
  deriving FromJson, ToJson, Inhabited

/-- Source operation that owns the words from `pc` up to the next entry. An empty source ends
    a range. Instructions are attributed by their own address. An instruction without a source
    takes the source of the last tagged data word its core loaded. -/
structure SourceEntry where
  pc : Nat
  source : String
  deriving FromJson, ToJson, Inhabited

structure CoreSpec where
  name : String
  memWords : Nat
  withMul : Bool
  queueDepth : Nat
  channels : Array ChannelSpec
  image : Array Nat
  sourceMap : Array SourceEntry
  /-- The board the core sits on (0 when the build has one board). -/
  board? : Option Nat := none
  deriving FromJson, ToJson, Inhabited

def CoreSpec.board (c : CoreSpec) : Nat := c.board?.getD 0

/-- Latencies in dspClk cycles. Stage counts follow RISC-Q `docs/soc`. -/
structure Model where
  /-- Register stages of the posted link, per direction. -/
  linkPipe : Nat
  /-- Store to the first link stage (`PutBridge`). -/
  bridge : Nat
  /-- Fire beat to timed-queue push (`fired`, `outParamFlow`). -/
  fireToPush : Nat
  /-- Frequency write to timed-queue push. -/
  freqToPush : Nat
  /-- The core's time register reads the converter-edge time minus this lag. -/
  coreTimeLag : Nat
  /-- `waitTimeCmp` releases once `time + waitSlack ≥ timeCmp`. -/
  waitSlack : Nat
  /-- Register stages from a pulse generator to its DAC port. -/
  dacPipe : Nat
  /-- Extra cycles after a taken branch or jump. -/
  redirectPenalty : Nat
  /-- Extra cycles for a load or store. The execute stage halts until the bus responds. -/
  busPenalty : Nat
  /-- System put: store to hub dispatch. -/
  hubDown : Nat
  /-- Hub dispatch to a core's inbox register. -/
  hubUp : Nat
  /-- Channel report to its core-local sink. -/
  reportUp : Nat
  /-- Decoder pipeline: a window edge at the carrier reaches the integrator this much later. -/
  decoder : Nat
  /-- Entries a FIFO sink holds before it drops. -/
  sinkDepth : Nat
  /-- System puts one source may have waiting at the hub arbiter before one is dropped. -/
  hubQueue : Nat
  /-- Board to board (RISC-Q PutLane on the White Rabbit GTY lane), measured on RISC-Q's RTL
      (validation/riscq/rtl/QosLaneTiming.scala): from a hub's dispatch of a frame to the far hub's
      lane input, at least `laneCross` cycles, on the first cycle `≡ lanePhase (mod laneWord)` (the lane's
      word clock), and no sooner than `laneFrame` cycles after the lane's previous frame. -/
  laneCross? : Option Nat := none
  laneFrame? : Option Nat := none
  laneWord? : Option Nat := none
  lanePhase? : Option Nat := none
  deriving FromJson, ToJson

/-- Result of one demodulation window. Windows of a channel consume their entries in order. -/
structure Readout where
  core : Nat
  channel : Nat
  res : Nat
  real : Int
  imag : Int
  deriving FromJson, ToJson

/-- The sixteen input lines of a digital channel take `levels` at cycle `atBatch`. -/
structure DioEdge where
  atBatch : Nat
  core : Nat
  channel : Nat
  levels : Nat
  deriving FromJson, ToJson

/-- One change of the sixteen input lines, `after` cycles after the pulse that causes it. -/
structure ResponseEdge where
  after : Nat
  levels : Nat
  deriving FromJson, ToJson

/-- What the apparatus sends back when a pulse reaches it: the `occurrence`-th window of a
    channel drives the input lines of a digital channel, for example photon clicks during a
    detection pulse. The response is supplied by the program. No device state is simulated. -/
structure Response where
  core : Nat
  channel : Nat
  occurrence : Nat
  toCore : Nat
  toChannel : Nat
  edges : Array ResponseEdge
  deriving FromJson, ToJson

/-- What a fired slot does to the apparatus. `delayPs` is the path from the converter or pin
    to the device. `detail` is carried to the effect frame unchanged. -/
structure Binding where
  core : Nat
  channel : Nat
  slot : Nat
  id : String
  part : String
  delayPs : Nat
  detail : Json
  deriving FromJson, ToJson

structure Program where
  kind : String
  version : Nat
  name : String
  dspPeriodPs : Nat
  timeOffset : Nat
  model : Model
  cores : Array CoreSpec
  readouts : Array Readout
  dioInputs : Array DioEdge
  responses : Array Response
  bindings : Array Binding
  trace : String
  maxBatches : Nat
  maxEvents : Nat
  maxSteps : Nat
  deriving FromJson, ToJson

def ramBase : UInt32 := 0x80000000
def putWindow : Nat := 0x10000
def localNodes : Nat := 16
def groupNodes : Nat := 4
def barrierIds : Nat := 16
def inboxNode0 : Nat := localNodes + groupNodes + barrierIds
def sinkBase : Nat := 0x4200
def sinkStride : Nat := 0x20
def hostWindow : Nat := 0x40000000

def kinds : List String := ["pulse", "demod", "dio"]

def ChannelSpec.lanes (c : ChannelSpec) : Nat :=
  if c.kind == "pulse" then 16 else if c.kind == "demod" then 4 else 0

def ChannelSpec.envBits (c : ChannelSpec) : Nat := if c.kind == "dio" then 1 else log2Up (max c.envDepth 2)

def Program.validate (p : Program) : Except String Unit := do
  unless p.kind == "riscq-soc" && p.version == 1 do throw "Unknown RISC-Q program version."
  unless 0 < p.dspPeriodPs && p.dspPeriodPs ≤ 1000000 && p.timeOffset < 4294967296 do
    throw "Use a dspClk period of 1 ps to 1 µs and a 32-bit time offset."
  unless ["full", "io"].contains p.trace do throw "Trace detail is full or io."
  unless 0 < p.maxEvents && p.maxEvents ≤ 400000 && 0 < p.maxSteps && p.maxSteps ≤ 2000000000 &&
      0 < p.maxBatches && p.maxBatches ≤ 2000000000 do throw "Run budget is out of range."
  let m := p.model
  unless m.linkPipe ≤ 64 && m.bridge ≤ 8 && m.fireToPush ≤ 8 && m.freqToPush ≤ 8 && m.coreTimeLag ≤ 256 &&
      m.waitSlack ≤ 16 && m.dacPipe ≤ 64 && m.redirectPenalty ≤ 16 && m.busPenalty ≤ 8 &&
      m.hubDown ≤ 256 && m.hubUp ≤ 256 && m.reportUp ≤ 256 && m.decoder ≤ 256 &&
      0 < m.sinkDepth && m.sinkDepth ≤ 1024 && 0 < m.hubQueue && m.hubQueue ≤ 64 do
    throw "A latency parameter is out of range."
  unless 0 < p.cores.size && p.cores.size ≤ 1024 do throw "Use 1–1024 cores (at most 16 per board)."
  for c in p.cores do
    unless 0 < c.memWords && c.memWords ≤ 16384 && c.image.size ≤ c.memWords do
      throw s!"Core {c.name}: the image must fit a RAM of at most 16384 words."
    unless c.image.all (· < 4294967296) do throw s!"Core {c.name}: image words are 32 bits."
    unless 0 < c.queueDepth && c.queueDepth ≤ 32 do throw s!"Core {c.name}: queue depth is 1–32."
    unless 0 < c.channels.size && c.channels.size ≤ localNodes do
      throw s!"Core {c.name}: use 1–16 channels."
    unless c.sourceMap.all (fun e ↦ e.pc % 4 == 0 && e.pc / 4 < c.memWords) do
      throw s!"Core {c.name}: a source map entry is outside the RAM."
    for ch in c.channels do
      unless kinds.contains ch.kind do throw s!"Channel {c.name}.{ch.name}: unknown kind {ch.kind}."
      -- The table must end below the start-time register (`decode_layout`).
      unless 0 < ch.slots && (ch.slots + 1) * 16 ≤ 0x4100 do
        throw s!"Channel {c.name}.{ch.name}: use 1–1039 pulse-table entries."
      unless ch.envDepth ≤ 65536 && 0 < ch.interp && ch.interp ≤ 16 do
        throw s!"Channel {c.name}.{ch.name}: envelope depth or interpolation is out of range."
      unless (ch.kind == "pulse") == ch.dac?.isSome && (ch.kind == "demod") == ch.adc?.isSome do
        throw s!"Channel {c.name}.{ch.name}: a pulse channel names a DAC and a demod channel an ADC."
      unless (ch.dac?.getD 0) < 64 && (ch.adc?.getD 0) < 64 do
        throw s!"Channel {c.name}.{ch.name}: converter index is out of range."
  let channel? := fun (core channel : Nat) ↦ (p.cores[core]?).bind (·.channels[channel]?)
  for r in p.readouts do
    unless (channel? r.core r.channel).any (·.kind == "demod") && r.res ≤ 1 &&
        r.real.natAbs < 2147483648 && r.imag.natAbs < 2147483648 do
      throw "A readout names a demod channel, a result bit and 32-bit integrals."
    -- The decoder's bit is the sign of its real integral.
    unless (r.res == 1) == decide (r.real < 0) do
      throw "A readout result bit is the sign of its real integral."
  let mut last := 0
  for e in p.dioInputs do
    unless (channel? e.core e.channel).any (·.kind == "dio") && e.levels < 65536 && last ≤ e.atBatch do
      throw "Digital inputs name a dio channel, 16 levels and nondecreasing times."
    last := e.atBatch
  for r in p.responses do
    unless (channel? r.core r.channel).any (·.kind != "dio") && (channel? r.toCore r.toChannel).any (·.kind == "dio") &&
        r.edges.all (·.levels < 65536) do
      throw "A response is caused by a pulse or demod channel and drives 16 lines of a dio channel."
  for b in p.bindings do
    unless (channel? b.core b.channel).any (b.slot < ·.slots) do
      throw s!"Binding {b.id} names a missing channel or pulse-table entry."

/-- One timed queue: the pop cycle of its newest entry and the pops still ahead. -/
structure Queue where
  lastPop : Option Nat := none
  pending : List Nat := []
  deriving Inhabited

/-- Push at cycle `push`. A full queue drops the entry, as a posted write does. -/
def Queue.push (q : Queue) (depth offset push startTime lead : Nat) : Queue × Option Nat :=
  let waiting := q.pending.filter (push ≤ ·)
  -- The registered head stage holds one entry beyond the FIFO depth.
  if waiting.length > depth then ({ q with pending := waiting }, none)
  else
    let pop := popCycle offset push startTime lead q.lastPop
    ({ lastPop := some pop, pending := waiting ++ [pop] }, some pop)

structure ChannelState where
  buffer : Buffer := {}
  amp : Queue := {}
  phase : Queue := {}
  addr : Queue := {}
  dur : Queue := {}
  freqCarrier : Queue := {}
  freqPhasor : Queue := {}
  /-- Carrier frequency code in effect at the converter. -/
  freqNow : Nat := 0
  /-- Cycle at which the last scheduled carrier update takes effect. -/
  freqLands : Option Nat := none
  /-- Cycle after the last scheduled window of this channel. -/
  windowEnd : Nat := 0
  windows : Nat := 0
  dout : Nat := 0
  din : Nat := 0
  deriving Inhabited

structure FifoEvent where
  word : UInt32 := 0
  time : UInt32 := 0
  seq : Nat := 0
  deriving Inhabited

structure SinkState where
  kind : String := "result"
  channel : Nat := 0
  valid : Bool := false
  res : UInt32 := 0
  real : UInt32 := 0
  imag : UInt32 := 0
  events : Array FifoEvent := #[]
  popped : FifoEvent := {}
  nextSeq : Nat := 0
  deriving Inhabited

/-- A read that stalls the core until its sink or timer is ready. -/
inductive Wait where
  | none
  | timeCmp (rd : Nat)
  | result (sink rd : Nat)
  | fifo (sink rd : Nat)
  | release (rd : Nat)
  | mailbox (index rd : Nat)
  deriving Inhabited, BEq

structure CoreState where
  cpu : Cpu := ⟨ramBase, Array.replicate 32 0⟩
  mem : Array UInt32 := #[]
  /-- Next cycle at which the core acts. `none` while stalled on a sink or stopped. -/
  readyAt : Option Nat := some 0
  wait : Wait := .none
  /-- Address of the stalled read and the instruction that issued it. -/
  waitAddress : UInt32 := 0
  waitPc : UInt32 := 0
  stopped : Option String := none
  timeCmp : UInt32 := 0
  done : Bool := false
  retired : Nat := 0
  channels : Array ChannelState := #[]
  sinks : Array SinkState := #[]
  board : Array UInt32 := Array.replicate groupNodes 0
  releaseBox : Option UInt32 := none
  mailboxes : Array (Option UInt32) := Array.replicate 2 none
  /-- Last frame this core emitted, and the frame that ended its stall. -/
  lastFrame : String := ""
  wakeFrame : String := ""
  sources : Array String := #[]
  /-- The core's pipeline (`QControl.RiscQ.Pipe`). -/
  pipe : Pipe := {}
  /-- Source of the last tagged data word the core loaded. It names the operation that
      untagged instructions, such as a table-driven loop, are working on. -/
  dataSource : String := ""

instance : Inhabited CoreState := ⟨{}⟩

/-- Where the four parameters of one fire take effect, in cycles. -/
structure Landing where
  amp : Option Nat
  phase : Option Nat
  addr : Option Nat
  dur : Nat

inductive Action where
  | put (core channel : Nat) (offset data : UInt32)
  | pulse (core channel : Nat) (fired : Fired) (phaseCode : Nat) (land : Landing)
  | freq (core channel code : Nat)
  | dioOut (core channel slot startTime mask value : Nat)
  | dioIn (core channel levels : Nat)
  | sinkClear (core sink : Nat)
  | sinkSettle (core sink : Nat) (res real imag : UInt32)
  | sinkEvent (core sink : Nat) (word time : UInt32)
  | hub (core node : Nat) (offset data : UInt32)
  /-- A put frame off the lane into board `dst`'s hub. `release` frames carry a barrier release: the
      arrivers on that board (global core indices) and the root's stamp in `data`. -/
  | lane (dst origin core node : Nat) (offset data : UInt32) (release : List Nat)
  | board (core group : Nat) (word : UInt32)
  | releaseBox (core : Nat) (t0 : UInt32)
  | mailbox (core index : Nat) (word : UInt32)
  | effect (binding : Nat)
  | hubServe (board : Nat)

structure Item where
  cycle : Nat
  seq : Nat
  cause : String
  pc : Option Nat
  source : Option String
  action : Action

/-- A system put waiting at the hub for the arbiter. -/
structure Beat where
  item : Item
  core : Nat
  node : Nat
  offset : UInt32
  data : UInt32
  /-- Cycle at which the put would be dispatched if the arbiter were free. -/
  arrived : Nat
  /-- A `wait` frame has reported this put. -/
  announced : Bool := false
  /-- It came off the lane, from board `origin`. -/
  fromLane : Bool := false
  origin : Nat := 0
  /-- A release frame: the arrivers on the receiving board. -/
  release : Option (List Nat) := none

/-- The board hub (RISC-Q `src/riscq/soc/link/PutHub.scala`), register by register: per source a
    `StreamFifo` (depth 8, latency 2) and its `m2sPipe`; the registered round-robin `grant` and `prio`;
    `popReg`; the `s1`, `s2` and `arb` pipe registers (`s2` halts on a barrier hazard); the write-back
    `wb`. The dispatch at `arb` leaves through one more register (`out << beat.stage()`). -/
structure HubState where
  groups : Array UInt32 := Array.replicate groupNodes 0
  arrivers : Array (List Nat) := Array.replicate barrierIds []
  expected : Array Nat := Array.replicate barrierIds 0
  countMismatch : Bool := false
  /-- Per source: the FIFO (each put with the cycle its pop side shows it) and the `m2sPipe` register. -/
  queues : Array (List (Beat × Nat)) := #[]
  heads : Array (Option Beat) := #[]
  grant : Option Nat := none
  /-- `prio`: the source the round robin scans from. -/
  prio : Nat := 0
  popReg : Option Nat := none
  s1 : Option Beat := none
  s2 : Option Beat := none
  arb : Option Beat := none
  /-- Barrier id written back this cycle (`wb.valid`). -/
  wb : Option Nat := none
  /-- A hub cycle is on the agenda. -/
  serving : Bool := false
  /-- Release frames still to leave (the root's `rel.busy` holds `arb`). -/
  relBusy : Nat := 0
  served : Nat := 0
  maxWait : Nat := 0
  peakWaiting : Nat := 0

/-- Round-robin grant (PutHub.md): the first source with a waiting put, scanning from the
    source after the one granted last. With no earlier grant the scan starts at source 0. -/
def nextSource (waiting : Array Bool) (granted : Option Nat) : Option Nat :=
  let start := match granted with
    | some g => g + 1
    | none => 0
  ((List.range waiting.size).map fun k ↦ (start + k) % waiting.size).find? fun i ↦ waiting.getD i false

/-- The arbiter grants only a source that has a put waiting. -/
theorem nextSource_waiting {waiting : Array Bool} {granted : Option Nat} {i : Nat}
    (h : nextSource waiting granted = some i) : waiting.getD i false = true := by
  exact List.find?_some (p := fun j ↦ waiting.getD j false) h

/-- While any source has a put waiting, the arbiter grants one every cycle. -/
theorem nextSource_isSome {waiting : Array Bool} (granted : Option Nat) {i : Nat}
    (hi : i < waiting.size) (h : waiting.getD i false = true) : (nextSource waiting granted).isSome := by
  unfold nextSource
  rw [List.find?_isSome]
  refine ⟨i, ?_, h⟩
  rw [List.mem_map]
  generalize (match granted with | some g => g + 1 | none => 0) = start
  generalize waiting.size = n at hi
  have hs : start % n < n := Nat.mod_lt _ (by omega)
  refine ⟨(i + n - start % n) % n, List.mem_range.mpr (Nat.mod_lt _ (by omega)), ?_⟩
  calc (start + (i + n - start % n) % n) % n
      = (start % n + (i + n - start % n)) % n := by
        rw [Nat.add_mod start, Nat.mod_mod, Nat.add_mod (start % n) (i + n - start % n), Nat.mod_mod]
    _ = (i + n) % n := by congr 1; omega
    _ = i := by rw [Nat.add_mod_right]; exact Nat.mod_eq_of_lt hi

structure Frame where
  id : String
  atBatch : Nat
  atPs : Nat
  op : String
  part : String
  targets : List String
  parents : List String
  pc? : Option Nat := none
  source? : Option String := none
  state : Json
  deriving ToJson

structure World where
  cores : Array CoreState
  /-- One hub per board; board 0 is the barrier root. -/
  hubs : Array HubState := #[{}]
  /-- Per lane (`from * 16 + to`): the earliest cycle the next frame can arrive (one frame time apart). -/
  laneFree : Array Nat := Array.replicate 256 0
  /-- Pending events, least (cycle, seq) first: the order a sorted list kept them in. -/
  agenda : Heap Item := {}
  /-- (ready cycle, core) of every core when it was last set; an entry counts only while it matches the
      core's current state, so the least valid entry is the core a scan of all cores would pick. -/
  ready : Heap (Nat × Nat) := {}
  seq : Nat := 0
  frames : Array Frame := #[]
  pulses : Array Json := #[]
  tones : Array Json := #[]
  faults : Array Json := #[]
  host : Array Json := #[]

/-- Value of the 32-bit batch-time register at a cycle. -/
def Program.timeReg (p : Program) (cycle : Nat) : Nat := (cycle + p.timeOffset) % 4294967296

/-- The core-local copy lags the converter-edge time by the link. -/
def Program.coreTime (p : Program) (cycle : Int) : UInt32 :=
  ofInt (cycle + p.timeOffset - p.model.coreTimeLag)

/-- Events by cycle, and in the order they were scheduled within a cycle. -/
def itemBefore (a b : Item) : Bool := a.cycle < b.cycle || (a.cycle == b.cycle && a.seq < b.seq)
/-- Cores by ready cycle, then by index. -/
def readyBefore (a b : Nat × Nat) : Bool := a.1 < b.1 || (a.1 == b.1 && a.2 < b.2)

def World.schedule (w : World) (cycle : Nat) (cause : String) (pc : Option Nat) (source : Option String)
    (action : Action) : World :=
  let item : Item := ⟨cycle, w.seq, cause, pc, source, action⟩
  { w with agenda := w.agenda.push itemBefore item, seq := w.seq + 1 }

def World.emit (w : World) (p : Program) (f : Frame) : World :=
  { w with frames := w.frames.push { f with atPs := f.atBatch * p.dspPeriodPs } }

def World.fault (w : World) (cycle : Nat) (part reason : String) : World :=
  { w with faults := w.faults.push (Json.mkObj [("atBatch", cycle), ("part", part), ("reason", reason)]) }

private def partOf (p : Program) (core : Nat) : String := (p.cores[core]?.map (·.name)).getD s!"core{core}"

private def channelPart (p : Program) (core channel : Nat) : String :=
  let name := ((p.cores[core]?).bind (·.channels[channel]?)).map (·.name) |>.getD s!"ch{channel}"
  s!"{partOf p core}.{name}"

private def converterPart (spec : ChannelSpec) (fallback : String) : String :=
  match spec.dac?, spec.adc? with
  | some d, _ => s!"dac{d}"
  | _, some a => s!"adc{a}"
  | _, _ => s!"{fallback}.pins"

private def slotJson (s : Slot) : Json :=
  Json.mkObj [("phase", s.phase), ("amp", s.amp), ("env", s.env), ("dur", s.dur)]

private def bufferJson (b : Buffer) : Json :=
  Json.mkObj [("startTime", b.startTime), ("freq", b.freq), ("dcOffset", b.dcOffset),
    ("phaseOffset", b.phaseOffset), ("table", toJson (b.table.map slotJson))]

private def sinkJson (s : SinkState) : Json :=
  if s.kind == "result" then
    Json.mkObj [("kind", s.kind), ("valid", s.valid), ("res", s.res.toNat), ("real", toJson (toSigned s.real)),
      ("imag", toJson (toSigned s.imag))]
  else
    Json.mkObj [("kind", s.kind), ("count", s.events.size), ("nextSeq", s.nextSeq),
      ("events", toJson (s.events.map fun e ↦ Json.mkObj [("word", e.word.toNat), ("time", e.time.toNat), ("seq", e.seq)]))]

/-- Let a stalled core complete its read on the cycle its sink becomes readable. Sink updates are
    scheduled at the cycle a read first sees them, and link events apply before cores act. -/
private def wake (core : CoreState) (cycle : Nat) (frame : String) (waitsFor : Wait → Bool) : CoreState :=
  if core.stopped.isNone && waitsFor core.wait then
    { core with readyAt := some cycle, wakeFrame := frame }
  else core

private def setCore (w : World) (i : Nat) (core : CoreState) : World :=
  let ready := match core.stopped, core.readyAt with
    | none, some r => w.ready.push readyBefore (r, i)
    | _, _ => w.ready
  { w with cores := w.cores.set! i core, ready }

private def modifyChannel (core : CoreState) (channel : Nat) (f : ChannelState → ChannelState) : CoreState :=
  { core with channels := core.channels.modify channel f }

/-- Apply one posted write at a channel and schedule what its fire releases. -/
private def applyPut (p : Program) (w : World) (t : Nat) (item : Item) (ci ch : Nat) (offset data : UInt32) : World :=
  Id.run do
  let some coreSpec := p.cores[ci]? | return w
  let some spec := coreSpec.channels[ch]? | return w
  let core := w.cores[ci]!
  let state := core.channels[ch]!
  let part := channelPart p ci ch
  let id := s!"e{item.seq}"
  let cmd := decodeCmd spec.slots spec.envBits offset.toNat data.toNat
  let (buffer, fired) := state.buffer.apply cmd
  let mut state := { state with buffer }
  let mut w := w
  let d : Datapath := {}
  let depth := coreSpec.queueDepth
  let off := p.timeOffset
  let mut op := "write"
  let mut detail : List (String × Json) := []
  match cmd with
  | .unmapped =>
    op := "ignored"
    w := w.fault t part s!"write to unmapped channel offset {offset.toNat}"
  | .setFreq code =>
    if spec.kind != "dio" then
      let push := t + p.model.freqToPush
      -- The frequency rides its own queues against the start time already in the buffer.
      let (qc, popC) := state.freqCarrier.push depth off push state.buffer.startTime d.leadFreqCarrier
      let (qp, popP) := state.freqPhasor.push depth off push state.buffer.startTime (d.leadFreqPhasor spec.lanes)
      state := { state with freqCarrier := qc, freqPhasor := qp }
      match popC, popP with
      | some c, some ph =>
        let land := max (c + d.leadFreqCarrier) (ph + d.leadFreqPhasor spec.lanes)
        -- Phasors regenerate serially. A second update inside that window restarts the
        -- regeneration, so the first frequency never reaches the carrier.
        if state.freqLands.any (fun previous ↦ land < previous + d.regenCycles spec.lanes) then
          w := w.fault t part "carrier update lands before the previous phasor regeneration finished"
        state := { state with freqLands := some land }
        w := w.schedule land id item.pc item.source (.freq ci ch code)
        detail := [("freqLands", toJson land)]
      | _, _ =>
        op := "drop"
        w := w.fault t part "frequency update dropped by a full timed queue"
  | .fire slot =>
    let some f := fired | pure ()
    op := "fire"
    if slot ≥ spec.slots then
      op := "drop"
      w := w.fault t part s!"fire of pulse-table entry {slot} outside the table"
    else if spec.kind == "dio" then
      let push := t + p.model.fireToPush
      let (q, pop) := state.dur.push depth off push f.startTime 1
      state := { state with dur := q }
      match pop with
      | some c =>
        w := w.schedule (c + 1) id item.pc item.source (.dioOut ci ch slot f.startTime f.entry.phase f.entry.amp)
        detail := [("slot", toJson slot), ("startTime", toJson f.startTime), ("lands", toJson (c + 1))]
      | none =>
        op := "drop"
        w := w.fault t part "digital update dropped by a full timed queue"
    else
      let push := t + p.model.fireToPush
      let (qa, popA) := state.amp.push depth off push f.startTime d.leadAmp
      let (qp, popP) := state.phase.push depth off push f.startTime d.leadPhase
      let (qe, popE) := state.addr.push depth off push f.startTime d.leadAddr
      let (qd, popD) := state.dur.push depth off push f.startTime d.leadDur
      state := { state with amp := qa, phase := qp, addr := qe, dur := qd }
      -- The virtual-Z offset is added at the generator's phase input when the entry is fired.
      let phaseCode := (f.entry.phase + state.buffer.phaseOffset) % 65536
      match popD with
      | some c =>
        let land : Landing := ⟨popA.map (· + d.leadAmp), popP.map (· + d.leadPhase), popE.map (· + d.leadAddr), c + d.leadDur⟩
        w := w.schedule land.dur id item.pc item.source (.pulse ci ch f phaseCode land)
        detail := [("slot", toJson slot), ("startTime", toJson f.startTime), ("lands", toJson land.dur)]
        if popA.isNone || popP.isNone || popE.isNone then
          w := w.fault t part "a pulse parameter was dropped by a full timed queue"
      | none =>
        op := "drop"
        w := w.fault t part "pulse dropped by a full timed queue"
  | _ => pure ()
  let core := modifyChannel core ch fun _ ↦ state
  w := setCore w ci core
  return w.emit p {
    id, atBatch := t, atPs := 0, op, part, targets := [], parents := [item.cause],
    pc? := item.pc, source? := item.source,
    state := Json.mkObj ([("offset", toJson offset.toNat), ("data", toJson data.toNat),
      ("buffer", bufferJson state.buffer)] ++ detail) }

/-- Boards of the build, and where a core sits on its board (its hub source and inbox unit). -/
def Program.boards (p : Program) : Nat := p.cores.foldl (fun m c ↦ max m (c.board + 1)) 1
def Program.boardCores (p : Program) (b : Nat) : Array Nat :=
  (p.cores.zipIdx.filter fun (c, _) ↦ c.board == b).map (·.2)
def Program.localIndex (p : Program) (ci : Nat) : Nat :=
  ((p.boardCores (p.cores[ci]!.board)).findIdx? (· == ci)).getD 0
/-- The hub sources of board `b`: its cores, then its lanes, each a `PutLane` with its own receive FIFO.
    Two boards (RISC-Q's RTL) have one lane each; with more (QuantumOS's star) board 0 has one lane per
    other board and every other board one lane to board 0. -/
def Program.hubLanes (p : Program) (b : Nat) : Nat :=
  if b == 0 && p.boards > 2 then p.boards - 1 else 1
def Program.hubSources (p : Program) (b : Nat) : Nat := (p.boardCores b).size + p.hubLanes b
/-- The source a frame off the lane enters at board `dst`: the lane from the board that sent it. Board 0
    receives only frames that other boards originate; every other board receives from board 0. -/
def Program.laneSource (p : Program) (dst origin : Nat) : Nat :=
  (p.boardCores dst).size + (if dst == 0 && p.boards > 2 then origin - 1 else 0)

private def getHub (w : World) (b : Nat) : HubState := w.hubs.getD b ({} : HubState)
private def setHub (w : World) (b : Nat) (h : HubState) : World :=
  let hubs := if w.hubs.size ≤ b then w.hubs ++ Array.replicate (b + 1 - w.hubs.size) ({} : HubState) else w.hubs
  { w with hubs := hubs.set! b h }

/-- The barrier a hub beat arrives at, if it is a barrier arrival. -/
private def Beat.barrier (b : Beat) : Option Nat :=
  if b.release.isNone && localNodes + groupNodes ≤ b.node && b.node < inboxNode0 then some (b.node - localNodes - groupNodes) else none

/-- Put a frame on the lane from board `src` to board `dst` at cycle `t` (`PutLane`): it reaches the far
    hub's lane input `laneCross` cycles later at the earliest, on the lane's word-clock phase, one frame
    time after the lane's previous frame. -/
private def sendLane (p : Program) (w : World) (t src dst : Nat) (beat : Beat) : World :=
  let cross := p.model.laneCross?.getD 310
  let frame := p.model.laneFrame?.getD 160
  let word := max 1 (p.model.laneWord?.getD 8)
  let phase := p.model.lanePhase?.getD 0
  let k := src * 16 + dst
  let earliest := max (t + cross) (w.laneFree.getD k 0)
  let r := earliest + (phase + word - earliest % word) % word
  let w := { w with laneFree := w.laneFree.set! k (r + frame) }
  w.schedule r s!"e{beat.item.seq}" beat.item.pc beat.item.source
    (.lane dst beat.origin beat.core beat.node beat.offset beat.data (beat.release.getD []))

/-- Boards a dispatched frame is forwarded to. RISC-Q's put network joins two boards over one lane: a
    board forwards its own publishes, arrivals and remote unicasts, never a frame off the lane. With more
    boards (QuantumOS's extension, not RISC-Q's RTL) board 0 has a lane to every other board and forwards
    what it receives to the boards that have not seen it. -/
private def forwardTo (p : Program) (b : Nat) (beat : Beat) (dest : Option Nat) : List Nat :=
  let n := p.boards
  if n ≤ 1 then []
  else if b == 0 then
    match dest with
    | some d => if d == 0 then [] else [d]
    | none => (List.range n).filter fun k ↦ k != 0 && k != beat.origin
  else if beat.fromLane then []
  else [0]

/-- Dispatch one system put at board `b`'s hub. -/
private def applyHub (p : Program) (w : World) (t b : Nat) (beat : Beat) (cause : String) (waited waiting : Nat) : World :=
  Id.run do
  let item := beat.item
  let ci := beat.core
  let node := beat.node
  let offset := beat.offset
  let data := beat.data
  let id := s!"e{item.seq}" ++ (if beat.fromLane then s!".b{b}" else "")
  let mut w := w
  let mut hub := getHub w b
  let mut op := "dispatch"
  let mut detail : List (String × Json) := [("from", toJson (partOf p ci)), ("node", toJson node),
    ("waited", toJson waited), ("waiting", toJson waiting), ("board", toJson b)]
  -- The beat leaves the output stage, crosses the per-core replica pipe, the up-link queue and link
  -- (`hubUp`, from riscq/soc.mjs); a read sees it from then on.
  let up := t + p.model.hubUp
  let mine := p.boardCores b
  let mut forward : List (Nat × Beat) := []
  if let some arrivers := beat.release then
    -- A release frame from the root: the arrivers on this board take the root's stamp.
    for target in arrivers do
      w := w.schedule up id item.pc item.source (.releaseBox target data)
    op := "release"
    detail := detail ++ [("t0", toJson data.toNat), ("fromRoot", toJson true)]
  else if node < localNodes + groupNodes then
    let g := node - localNodes
    let slot := (data.toNat / 2) % 32
    let bit := data &&& 1
    let word := hub.groups[g]!
    let word := (word &&& ~~~((1 : UInt32) <<< slot.toUInt32)) ||| (bit <<< slot.toUInt32)
    hub := { hub with groups := hub.groups.set! g word }
    op := "publish"
    detail := detail ++ [("group", toJson g), ("slot", toJson slot), ("bit", toJson bit.toNat), ("word", toJson word.toNat)]
    for target in mine do
      w := w.schedule up id item.pc item.source (.board target g word)
    forward := (forwardTo p b beat none).map (·, beat)
  else if node < inboxNode0 then
    let bar := node - localNodes - groupNodes
    if b != 0 then
      -- A non-root forwards an arrival to the root, which counts every arrival (PutHub.scala).
      op := "forward"
      detail := detail ++ [("barrier", toJson bar)]
      forward := (forwardTo p b beat (some 0)).map (·, beat)
    else
      let arrived := hub.arrivers[bar]!
      let expected := if arrived.isEmpty then data.toNat else hub.expected[bar]!
      let mismatch := hub.countMismatch || data.toNat != expected
      let arrived := if arrived.contains ci then arrived else arrived ++ [ci]
      op := "arrive"
      detail := detail ++ [("barrier", toJson bar), ("arrived", toJson arrived.length), ("expected", toJson expected)]
      if arrived.length ≥ expected then
        -- The last arrival releases every arriver with the root's time. `hub.time := RegNext(syncTime)`.
        -- This model's time base is the batch at which a pulse opens at its channel output for its
        -- start time: two batches behind `RegNext(syncTime)` (measured on RISC-Q's RTL,
        -- validation/riscq/rtl/firmware-rtl.mjs).
        let t0 := (p.timeReg t + 2).toUInt32
        for target in arrived.filter (fun c ↦ p.cores[c]!.board == 0) do
          w := w.schedule up id item.pc item.source (.releaseBox target t0)
        -- One release frame per other board with arrivers, one per cycle while the arbiter is held.
        let remote := ((List.range p.boards).filter (· != 0)).filter fun k ↦ arrived.any (fun c ↦ p.cores[c]!.board == k)
        for (k, i) in remote.zipIdx do
          let frameBeat : Beat := { beat with data := t0, release := some (arrived.filter (fun c ↦ p.cores[c]!.board == k)), origin := 0, fromLane := false }
          w := sendLane p w (t + 1 + i) 0 k frameBeat
        let cleared := { hub with arrivers := hub.arrivers.set! bar [], expected := hub.expected.set! bar 0 }
        hub := { cleared with countMismatch := mismatch, relBusy := remote.length }
        op := "release"
        detail := detail ++ [("t0", toJson t0.toNat), ("remoteBoards", toJson remote.length)]
      else
        hub := { hub with
          arrivers := hub.arrivers.set! bar arrived, expected := hub.expected.set! bar expected,
          countMismatch := mismatch }
  else
    let tb := node / 256
    let unit := node % 256
    let address := sinkBase + offset.toNat
    let index := (address - 0x4340) / sinkStride
    let targets := p.boardCores tb
    if unit ≥ inboxNode0 && unit - inboxNode0 < targets.size && address ≥ 0x4340 &&
        (address - 0x4340) % sinkStride == 0 && index < 2 then
      let target := targets[unit - inboxNode0]!
      if tb == b then
        op := "signal"
        detail := detail ++ [("to", toJson (partOf p target)), ("mailbox", toJson index), ("word", toJson data.toNat)]
        w := w.schedule up id item.pc item.source (.mailbox target index data)
      else
        op := "forward"
        detail := detail ++ [("to", toJson (partOf p target)), ("toBoard", toJson tb)]
        forward := (forwardTo p b beat (some tb)).map (·, beat)
    else
      op := "ignored"
      w := w.fault t "hub" s!"system put to unknown node {node} offset {offset.toNat}"
  w := setHub w b hub
  for (dst, fb) in forward do
    w := sendLane p w t b dst { fb with origin := if fb.fromLane then fb.origin else b }
  return w.emit p {
    id, atBatch := t, atPs := 0, op, part := "hub", targets := [], parents := [cause],
    pc? := item.pc, source? := item.source, state := Json.mkObj detail }

/-- System puts the hub holds: in its FIFOs, its source registers and its pipe registers. -/
private def hubHeld (h : HubState) : Nat :=
  -- A source register being popped (`popReg`) still shows the put that `s1` already holds.
  let heads := (h.heads.zipIdx.filter fun (b, i) ↦ b.isSome && h.popReg != some i).size
  h.queues.foldl (fun k q ↦ k + q.length) 0 + heads +
    [h.s1, h.s2, h.arb].foldl (fun k b ↦ k + (if b.isSome then 1 else 0)) 0

/-- A put reaches board `b`'s hub at cycle `t` from source `src` (a core's `xput`, or the lane, the
    last source) and is pushed into that source's FIFO, whose pop side shows it two cycles later
    (`StreamFifo`, latency 2). A put into a full FIFO (depth `hubQueue`) is dropped: the input is a
    `Flow`, posted. -/
private def hubPush (p : Program) (w : World) (t b src : Nat) (beat : Beat) : World :=
  Id.run do
  let n := p.hubSources b
  let hub0 := getHub w b
  let hub := if hub0.queues.size < n then
      { hub0 with queues := Array.replicate n [], heads := Array.replicate n none } else hub0
  let queue := hub.queues.getD src []
  let item := beat.item
  if queue.length ≥ p.model.hubQueue then
    let w := w.fault t "hub" s!"the hub queue of {if src ≥ (p.boardCores b).size then s!"the lane from board {beat.origin}" else partOf p beat.core} on board {b} is full: a system put to node {beat.node} is dropped"
    return w.emit p {
      id := s!"e{item.seq}.drop{b}", atBatch := t, atPs := 0, op := "drop", part := "hub", targets := [],
      parents := [item.cause], pc? := item.pc, source? := item.source,
      state := Json.mkObj [("from", toJson (partOf p beat.core)), ("node", toJson beat.node), ("queued", toJson queue.length), ("board", toJson b)] }
  let beat := { beat with arrived := t, announced := true }
  let queues := hub.queues.set! src (queue ++ [((beat, t + 2) : Beat × Nat)])
  let hub := { hub with queues := queues }
  let waiting := hubHeld hub
  let waitId := s!"e{item.seq}.wait" ++ (if beat.fromLane then s!".b{b}" else "")
  let mut w := setHub w b { hub with peakWaiting := max hub.peakWaiting waiting }
  -- Every put is held in the hub's pipeline from its arrival to its dispatch; its dispatch names
  -- this frame as its cause, and the dispatch frame states how many puts the hub still holds.
  w := w.emit p {
    id := waitId, atBatch := t, atPs := 0, op := "wait", part := "hub", targets := [],
    parents := [item.cause], pc? := item.pc, source? := item.source,
    state := Json.mkObj [("from", toJson (partOf p beat.core)), ("node", toJson beat.node), ("waiting", toJson waiting), ("board", toJson b)] }
  unless (getHub w b).serving do
    w := setHub w b { getHub w b with serving := true }
    w := w.schedule (t + 2) "hub" none none (.hubServe b)
  return w

/-- A core's system put reaches its board's hub (`hub.in(i)`, the `xput` flow). -/
private def hubArrive (p : Program) (w : World) (t : Nat) (item : Item) (ci node : Nat) (offset data : UInt32) : World :=
  let b := p.cores[ci]!.board
  hubPush p w t b (p.localIndex ci) { item, core := ci, node, offset, data, arrived := t, origin := b }

/-- One cycle of board `b`'s hub, as the registers of `PutHub.scala` update at its end. While the root
    has release frames to send (`rel.busy`), `arb` is held. -/
private def hubServe (p : Program) (w : World) (t b : Nat) : World := Id.run do
  let mut w := w
  let h := getHub w b
  let n := h.heads.size
  let valids := h.heads.map (·.isSome)
  -- Combinational signals of this cycle.
  let hazard := match h.s2.bind Beat.barrier with
    | some bar => (h.arb.bind Beat.barrier) == some bar || h.wb == some bar
    | none => false
  let arbFire := h.arb.isSome && h.relBusy == 0
  let arbIn := h.arb.isNone || arbFire
  let s2Fire := h.s2.isSome && !hazard && arbIn
  let s2In := h.s2.isNone || s2Fire
  let s1Fire := h.s1.isSome && s2In
  let s1In := h.s1.isNone || s1Fire
  let picked : Option Beat := match h.grant with
    | some g => if valids.getD g false && h.popReg != some g then h.heads[g]! else none
    | none => none
  let pickedFire := picked.isSome && s1In
  let advance := picked.isNone || s1In
  -- Dispatch at `arb`.
  if arbFire then
    if let some beat := h.arb then
      let waiting := hubHeld h - 1
      let cause := s!"e{beat.item.seq}.wait" ++ (if beat.fromLane then s!".b{b}" else "")
      w := applyHub p w t b beat cause (t - beat.arrived) waiting
      let h2 := getHub w b
      w := setHub w b { h2 with served := h2.served + 1, maxWait := max h2.maxWait (t - beat.arrived) }
  -- Next state. (`applyHub` changed only the group words, the barrier counts and `relBusy`.)
  let wb := if arbFire then (h.arb.bind Beat.barrier) else none
  let arb := if s2Fire then h.s2 else if arbFire then none else h.arb
  let s2 := if s2In then (if s1Fire then h.s1 else none) else h.s2
  let s1 := if s1In then (if pickedFire then picked else none) else h.s1
  let popReg := if pickedFire then h.grant else none
  let mut grant := h.grant
  let mut prio := h.prio
  if advance then
    -- `OHMasking.roundRobin(valids, prio)`: the first requesting source at or after `prio`.
    let next := ((List.range n).map fun k ↦ (h.prio + k) % n).find? fun i ↦ valids.getD i false
    grant := next
    if let some g := next then prio := (g + 1) % n
  -- Each source's `m2sPipe` takes the FIFO head when it is empty or popped (`s.ready := popReg(i)`).
  let mut heads := h.heads
  let mut queues := h.queues
  for i in [0:n] do
    let popped := h.popReg == some i
    if h.heads[i]!.isNone || popped then
      match queues[i]! with
      | (beat, visible) :: rest =>
        if visible ≤ t then
          heads := heads.set! i (some beat)
          queues := queues.set! i rest
        else heads := heads.set! i none
      | [] => heads := heads.set! i none
  let cur := getHub w b
  let relBusy := if h.relBusy > 0 then h.relBusy - 1 else cur.relBusy
  let hub := { cur with heads, queues, grant, prio, popReg, s1, s2, arb, wb, relBusy }
  let busy := hub.heads.any (·.isSome) || hub.queues.any (!·.isEmpty) || hub.s1.isSome || hub.s2.isSome ||
    hub.arb.isSome || hub.wb.isSome || hub.grant.isSome || hub.popReg.isSome || hub.relBusy > 0
  w := setHub w b { hub with serving := busy }
  if busy then return w.schedule (t + 1) "hub" none none (.hubServe b)
  return w

/-- Apply one scheduled converter-edge, link or hub event. -/
def applyItem (p : Program) (w : World) (item : Item) : World := Id.run do
  let t := item.cycle
  let id := s!"e{item.seq}"
  let frame := fun (op part : String) (targets : List String) (state : Json) ↦
    ({ id, atBatch := t, atPs := 0, op, part, targets, parents := [item.cause], pc? := item.pc,
       source? := item.source, state } : Frame)
  match item.action with
  | .put ci ch offset data => return applyPut p w t item ci ch offset data
  | .hub ci node offset data => return hubArrive p w t item ci node offset data
  | .hubServe b => return hubServe p w t b
  | .lane dst origin ci node offset data release =>
    let src := p.laneSource dst origin
    let rel : Option (List Nat) := if node < inboxNode0 && localNodes + groupNodes ≤ node && !release.isEmpty then some release else none
    let beat : Beat := { item, core := ci, node, offset, data, arrived := t, fromLane := true, origin, release := rel }
    return hubPush p w t dst src beat
  | .pulse ci ch f phaseCode land =>
    let some spec := (p.cores[ci]?).bind (·.channels[ch]?) | return w
    let core := w.cores[ci]!
    let state := core.channels[ch]!
    let part := channelPart p ci ch
    let dur := f.entry.dur
    let aligned := land.amp == some land.dur && land.phase == some land.dur && land.addr == some land.dur
    let onTime := p.timeReg t == f.startTime
    let overlap := decide (t < state.windowEnd)
    let window := state.windows
    let converter := converterPart spec part
    let atConverter := if spec.kind == "pulse" then t + p.model.dacPipe else t
    let record := Json.mkObj [
      ("id", id), ("core", ci), ("channel", ch), ("part", part), ("kind", spec.kind), ("converter", converter),
      ("slot", f.slot), ("startTime", f.startTime), ("opens", t), ("closes", t + dur), ("atConverter", atConverter),
      ("dur", dur), ("amp", f.entry.amp), ("phase", phaseCode), ("env", f.entry.env), ("freq", state.freqNow),
      ("dcOffset", state.buffer.dcOffset), ("aligned", aligned), ("onTime", onTime), ("overlap", overlap),
      ("ampLands", toJson land.amp), ("phaseLands", toJson land.phase), ("envLands", toJson land.addr),
      ("source", toJson item.source)]
    let mut w := w
    if !onTime then w := w.fault t part s!"pulse opened at batch time {p.timeReg t}, scheduled for {f.startTime}"
    if !aligned then w := w.fault t part "pulse parameters did not land on the same batch"
    if overlap then w := w.fault t part "pulse window opened before the previous one closed"
    let core := modifyChannel core ch fun s ↦ { s with windowEnd := t + dur, windows := window + 1 }
    w := setCore w ci core
    w := { w with pulses := w.pulses.push record }
    w := w.emit p (frame "pulse" part [converter] record)
    for (b, bi) in p.bindings.zipIdx do
      if b.core == ci && b.channel == ch && b.slot == f.slot then
        w := w.schedule atConverter id item.pc item.source (.effect bi)
    for r in p.responses do
      if r.core == ci && r.channel == ch && r.occurrence == window then
        for e in r.edges do
          w := w.schedule (atConverter + e.after) id item.pc item.source (.dioIn r.toCore r.toChannel e.levels)
    if spec.kind == "demod" then
      -- Firing the demodulation carrier is the readout. Its window drives the decoder.
      let sink := ((p.cores[ci]!.channels.toList.take ch).filter (fun c ↦ c.kind != "pulse")).length
      let outcome := (p.readouts.toList.filter fun r ↦ r.core == ci && r.channel == ch)[window]?
      let res := (outcome.map (·.res)).getD 0
      let real := (outcome.map (·.real)).getD 0
      let imag := (outcome.map (·.imag)).getD 0
      w := w.schedule (t + p.model.decoder + p.model.reportUp) id item.pc item.source (.sinkClear ci sink)
      w := w.schedule (t + dur + p.model.decoder + p.model.reportUp) id item.pc item.source
        (.sinkSettle ci sink res.toUInt32 (ofInt real) (ofInt imag))
    return w
  | .freq ci ch code =>
    let core := modifyChannel w.cores[ci]! ch fun s ↦ { s with freqNow := code }
    let part := channelPart p ci ch
    let record := Json.mkObj [("id", id), ("core", ci), ("channel", ch), ("part", part), ("kind", "freq"),
      ("opens", t), ("freq", code), ("source", toJson item.source)]
    let w := { w with tones := w.tones.push record }
    return (setCore w ci core).emit p (frame "freq" part [] record)
  | .dioOut ci ch slot startTime mask value =>
    let core := w.cores[ci]!
    let before := core.channels[ch]!.dout
    let after := (before &&& (65535 ^^^ mask)) ||| (value &&& mask)
    let core := modifyChannel core ch fun s ↦ { s with dout := after }
    let part := channelPart p ci ch
    let mut w := setCore w ci core
    let onTime := p.timeReg t == startTime
    let record := Json.mkObj [("id", id), ("core", ci), ("channel", ch), ("part", part), ("kind", "dio"),
      ("converter", s!"{part}.pins"), ("slot", slot), ("startTime", startTime), ("opens", t), ("atConverter", t),
      ("mask", mask), ("value", value), ("levels", after), ("onTime", onTime), ("source", toJson item.source)]
    if !onTime then w := w.fault t part s!"digital update applied at batch time {p.timeReg t}, scheduled for {startTime}"
    w := { w with pulses := w.pulses.push record }
    w := w.emit p (frame "dio" part [s!"{part}.pins"] record)
    for (b, bi) in p.bindings.zipIdx do
      if b.core == ci && b.channel == ch && b.slot == slot then
        w := w.schedule t id item.pc item.source (.effect bi)
    return w
  | .dioIn ci ch levels =>
    let core := w.cores[ci]!
    let before := core.channels[ch]!.din
    let changed := before ^^^ levels
    let core := modifyChannel core ch fun s ↦ { s with din := levels }
    let part := channelPart p ci ch
    let mut w := setCore w ci core
    if changed != 0 then
      let sink := ((p.cores[ci]!.channels.toList.take ch).filter (fun c ↦ c.kind != "pulse")).length
      let word := (changed * 65536 + levels).toUInt32
      w := w.schedule (t + p.model.reportUp) id item.pc item.source (.sinkEvent ci sink word (p.timeReg t).toUInt32)
    let edge := frame "edge" s!"{part}.pins" [part]
      (Json.mkObj [("levels", levels), ("changed", changed), ("time", p.timeReg t)])
    -- A scripted input has no cause inside the model. A response descends from its pulse.
    return w.emit p { edge with parents := if item.cause == "" then [] else [item.cause] }
  | .sinkClear ci k =>
    let core := w.cores[ci]!
    let core := { core with sinks := core.sinks.modify k fun s ↦ { s with valid := false } }
    return (setCore w ci core).emit p (frame "clear" s!"{partOf p ci}.inbox" [] (sinkJson core.sinks[k]!))
  | .sinkSettle ci k res real imag =>
    let core := w.cores[ci]!
    let core := { core with sinks := core.sinks.modify k fun s ↦ { s with valid := true, res, real, imag } }
    let core := wake core t id fun wait ↦ match wait with | .result s _ => s == k | _ => false
    return (setCore w ci core).emit p (frame "result" s!"{partOf p ci}.inbox" [partOf p ci] (sinkJson core.sinks[k]!))
  | .sinkEvent ci k word time =>
    let core := w.cores[ci]!
    let sink := core.sinks[k]!
    let full := decide (sink.events.size ≥ p.model.sinkDepth)
    let sink := if full then { sink with nextSeq := sink.nextSeq + 1 }
      else { sink with events := sink.events.push ⟨word, time, sink.nextSeq⟩, nextSeq := sink.nextSeq + 1 }
    let core := { core with sinks := core.sinks.set! k sink }
    let core := wake core t id fun wait ↦ match wait with | .fifo s _ => s == k | _ => false
    let w := if full then w.fault t s!"{partOf p ci}.inbox" "input event dropped by a full sink" else w
    return (setCore w ci core).emit p (frame (if full then "drop" else "event") s!"{partOf p ci}.inbox"
      [partOf p ci] (sinkJson sink))
  | .board ci g word =>
    let core := w.cores[ci]!
    let core := { core with board := core.board.set! g word }
    return (setCore w ci core).emit p (frame "board" s!"{partOf p ci}.inbox" []
      (Json.mkObj [("group", g), ("word", word.toNat)]))
  | .releaseBox ci t0 =>
    let core := { w.cores[ci]! with releaseBox := some t0 }
    let core := wake core t id fun wait ↦ match wait with | .release _ => true | _ => false
    return (setCore w ci core).emit p (frame "released" s!"{partOf p ci}.inbox" [partOf p ci]
      (Json.mkObj [("t0", t0.toNat)]))
  | .mailbox ci m word =>
    let core := w.cores[ci]!
    let core := { core with mailboxes := core.mailboxes.set! m (some word) }
    let core := wake core t id fun wait ↦ match wait with | .mailbox i _ => i == m | _ => false
    return (setCore w ci core).emit p (frame "mail" s!"{partOf p ci}.inbox" [partOf p ci]
      (Json.mkObj [("mailbox", m), ("word", word.toNat)]))
  | .effect bi =>
    let some b := p.bindings[bi]? | return w
    return w.emit p (frame "effect" b.part [] (Json.mkObj [("binding", b.id),
      ("arrivesPs", t * p.dspPeriodPs + b.delayPs), ("detail", b.detail)]))

/-- Outcome of a core-local read. -/
inductive Loaded where
  | value (v : UInt32) (core : CoreState) (name : String)
  | stall (wait : Wait) (until? : Option Nat) (name : String)
  | bad (reason : String)

/-- Read one control-block register. Halting reads stall until their sink is ready. -/
def loadIo (p : Program) (t : Nat) (core : CoreState) (address : UInt32) (rd : Nat) : Loaded :=
  let a := address.toNat
  if a == 0xBFF8 then .value (p.coreTime t) core "time"
  else if a == 0x4000 then .value core.timeCmp core "timeCmp"
  else if a == 0x4010 then .value (if core.done then 1 else 0) core "done"
  else if a == 0x2000 then .value 0 core "fromHost"
  else if a == 0x4008 then
    -- The compare is registered, so the flag seen at cycle t reflects cycle t − 1.
    let distance := toSigned (core.timeCmp - (p.coreTime ((t : Int) - 1) + p.model.waitSlack.toUInt32))
    if distance ≤ 0 then .value 0 core "waitTimeCmp" else .stall (.timeCmp rd) (some (t + distance.toNat)) "waitTimeCmp"
  else if a ≥ sinkBase && a < sinkBase + sinkStride * core.sinks.size then
    let k := (a - sinkBase) / sinkStride
    let word := (a - sinkBase) % sinkStride
    let sink := core.sinks[k]!
    if sink.kind == "result" then
      if word == 0 then (if sink.valid then .value sink.res core "res" else .stall (.result k rd) none "res")
      else if word == 4 then .value sink.real core "real"
      else if word == 8 then .value sink.imag core "imag"
      else .bad s!"read of unmapped result register 0x{String.ofList (Nat.toDigits 16 a)}"
    else
      if word == 0 then
        match sink.events[0]? with
        | some e =>
          let sink := { sink with events := sink.events.extract 1 sink.events.size, popped := e }
          .value e.word { core with sinks := core.sinks.set! k sink } "popEvent"
        | none => .stall (.fifo k rd) none "popEvent"
      else if word == 4 || word == 8 then .value 0 core "eventWord"
      else if word == 0x10 then .value sink.popped.time core "eventTime"
      else if word == 0x14 then .value sink.popped.seq.toUInt32 core "eventSeq"
      else if word == 0x18 then .value sink.events.size.toUInt32 core "eventCount"
      else .bad s!"read of unmapped event register 0x{String.ofList (Nat.toDigits 16 a)}"
  else if a ≥ 0x4300 && a < 0x4300 + 4 * groupNodes && a % 4 == 0 then
    .value core.board[(a - 0x4300) / 4]! core "board"
  else if a == 0x4320 then
    match core.releaseBox with
    | some v => .value v { core with releaseBox := none } "release"
    | none => .stall (.release rd) none "release"
  else if a == 0x4340 || a == 0x4360 then
    let m := (a - 0x4340) / sinkStride
    match core.mailboxes[m]! with
    | some v => .value v { core with mailboxes := core.mailboxes.set! m none } "mailbox"
    | none => .stall (.mailbox m rd) none "mailbox"
  else .bad s!"load from unmapped address 0x{String.ofList (Nat.toDigits 16 a)}"

def readRam (mem : Array UInt32) (op : LdOp) (address : UInt32) : Option UInt32 :=
  let offset := address - ramBase
  match mem[(offset >>> 2).toNat]? with
  | none => none
  | some word =>
    let shift := (offset &&& 3) <<< 3
    match op with
    | .lw => if offset &&& 3 == 0 then some word else none
    | .lh => if offset &&& 1 == 0 then some (signExtend (word >>> shift) 16) else none
    | .lhu => if offset &&& 1 == 0 then some ((word >>> shift) &&& 0xFFFF) else none
    | .lb => some (signExtend (word >>> shift) 8)
    | .lbu => some ((word >>> shift) &&& 0xFF)

def writeRam (mem : Array UInt32) (op : StOp) (address value : UInt32) : Option (Array UInt32) :=
  let offset := address - ramBase
  let index := (offset >>> 2).toNat
  match mem[index]? with
  | none => none
  | some word =>
    let shift := (offset &&& 3) <<< 3
    match op with
    | .sw => if offset &&& 3 == 0 then some (mem.set! index value) else none
    | .sh => if offset &&& 1 == 0 then
        some (mem.set! index ((word &&& ~~~((0xFFFF : UInt32) <<< shift)) ||| ((value &&& 0xFFFF) <<< shift)))
      else none
    | .sb => some (mem.set! index ((word &&& ~~~((0xFF : UInt32) <<< shift)) ||| ((value &&& 0xFF) <<< shift)))

/-- A word read returns what a word write stored. -/
theorem readRam_writeRam_word (mem mem' : Array UInt32) (address value : UInt32)
    (stored : writeRam mem .sw address value = some mem') :
    readRam mem' .lw address = some value := by
  dsimp only [writeRam] at stored
  dsimp only [readRam]
  generalize ((address - ramBase) >>> 2).toNat = index at *
  generalize address - ramBase = offset at *
  cases found : mem[index]? with
  | none => simp [found] at stored
  | some word =>
    have inRange : index < mem.size := by
      obtain ⟨h, _⟩ := Array.getElem?_eq_some_iff.mp found
      exact h
    simp only [found] at stored
    split at stored
    · rename_i aligned
      injection stored with written
      subst written
      simp [aligned, inRange]
    · simp at stored

private def isRam (core : CoreState) (address : UInt32) : Bool :=
  address ≥ ramBase && ((address - ramBase) >>> 2).toNat < core.mem.size

private def rdOf : Instr → Option Nat
  | .lui rd _ | .auipc rd _ | .jal rd _ | .jalr rd _ _ | .opImm _ rd _ _ | .op _ rd _ _ | .mulOp _ rd _ _ => some rd
  | _ => none

private def hex32 (v : UInt32) : String := "0x" ++ String.ofList (Nat.toDigits 16 v.toNat)

/-- The architectural effect of the instruction of core `ci` that leaves execute at cycle `t`, or
    the completion of its stalled read. `outAt`: for a store, the cycle the write leaves the core on
    the posted link or the host window (`Pipe.acceptStore`). -/
def retire (p : Program) (w : World) (t ci : Nat) (outAt : Nat) : World := Id.run do
  let spec := p.cores[ci]!
  let core := w.cores[ci]!
  -- Take the core out of the array so its RAM is updated in place.
  let mut w := setCore w ci default
  let name := spec.name
  let id := s!"{name}:{core.retired}"
  let pc := if core.wait != .none then core.waitPc else core.cpu.pc
  let source := (core.sources[((pc - ramBase) >>> 2).toNat]?.filter (· != "")).orElse
    fun _ ↦ if core.dataSource == "" then none else some core.dataSource
  let parents := [core.lastFrame, core.wakeFrame].filter (· != "")
  let full := p.trace == "full"
  let frame := fun (op : String) (targets : List String) (state : List (String × Json)) ↦
    ({ id, atBatch := t, atPs := 0, op, part := name, targets, parents, pc? := some pc.toNat, source? := source,
       state := Json.mkObj ([("pc", toJson pc.toNat)] ++ state) } : Frame)
  let stop := fun (w : World) (core : CoreState) (op reason : String) ↦
    let core := { core with stopped := some reason, readyAt := none, lastFrame := id }
    (setCore w ci core).emit p (frame op [] [("reason", reason)])
  -- A stalled read completes here once its sink is ready.
  if core.wait != .none then
    let rd := match core.wait with
      | .timeCmp rd | .result _ rd | .fifo _ rd | .release rd | .mailbox _ rd => rd
      | .none => 0
    match loadIo p t core core.waitAddress rd with
    | .value v core register =>
      -- The stalled read keeps its instruction number. Its completion is a second frame.
      let resumed := s!"{id}.resume"
      let core := { core with
        cpu := core.cpu.setReg rd v, wait := .none, readyAt := some (t + 1),
        retired := core.retired + 1, lastFrame := resumed, wakeFrame := "" }
      return (setCore w ci core).emit p { (frame "resume" [] [("register", register), ("rd", rd), ("value", v.toNat)]) with id := resumed }
    | .stall wait until? _ =>
      return setCore w ci { core with wait, readyAt := until? }
    | .bad reason => return stop w core "fault" reason
  let some word := readRam core.mem .lw pc | return stop w core "fault" s!"program counter {hex32 pc} is outside RAM"
  let instr := decode word spec.withMul
  if instr.isSelfJump then return stop w core "park" "parked in a self jump"
  let step := exec core.cpu instr
  -- Built only for an instruction that is recorded: most instructions of a long program are not.
  let base := fun (_ : Unit) ↦ ([("word", toJson word.toNat), ("text", toJson instr.text)] : List (String × Json))
  match step.access with
  | .stop reason => return stop w core "fault" reason
  | .none =>
    let core := { core with cpu := step.cpu, readyAt := some (t + 1), retired := core.retired + 1 }
    if !full then return setCore w ci core
    let write := match rdOf instr with
      | some rd => if rd == 0 then [] else [("rd", toJson rd), ("value", toJson (step.cpu.reg rd).toNat)]
      | none => []
    return (setCore w ci { core with lastFrame := id, wakeFrame := "" }).emit p (frame "exec" [] (base () ++ write))
  | .load op rd address =>
    if isRam core address then
      let some v := readRam core.mem op address | return stop w core "fault" s!"misaligned load at {hex32 address}"
      let tag := (core.sources[((address - ramBase) >>> 2).toNat]?).getD ""
      let core := { core with
        cpu := step.cpu.setReg rd v, readyAt := some (t + 1),
        retired := core.retired + 1, dataSource := if tag == "" then core.dataSource else tag }
      if !full then return setCore w ci core
      return (setCore w ci { core with lastFrame := id, wakeFrame := "" }).emit p
        (frame "exec" [] (base () ++ [("address", toJson address.toNat), ("rd", toJson rd), ("value", toJson v.toNat)]))
    if op != .lw || address &&& 3 != 0 then return stop w core "fault" s!"control registers take aligned word loads ({hex32 address})"
    match loadIo p t { core with cpu := step.cpu } address rd with
    | .value v core register =>
      let core := { core with
        cpu := core.cpu.setReg rd v, readyAt := some (t + 1),
        retired := core.retired + 1, lastFrame := id, wakeFrame := "" }
      return (setCore w ci core).emit p (frame "read" [] (base () ++
        [("register", toJson register), ("address", toJson address.toNat), ("rd", toJson rd), ("value", toJson v.toNat)]))
    | .stall wait until? register =>
      let core := { core with
        cpu := step.cpu, wait, waitAddress := address, waitPc := pc, readyAt := until?,
        lastFrame := id, wakeFrame := "" }
      return (setCore w ci core).emit p (frame "wait" [] (base () ++
        [("register", toJson register), ("address", toJson address.toNat), ("until", toJson until?)]))
    | .bad reason => return stop w core "fault" reason
  | .store op address value =>
    let a := address.toNat
    if isRam core address then
      -- Detach the RAM from the core record, so that the store updates the array in place
      -- and does not copy it.
      let ram := core.mem
      let core := { core with mem := #[] }
      let some mem := writeRam ram op address value
        | return stop w { core with mem := ram } "fault" s!"misaligned store at {hex32 address}"
      let core := { core with cpu := step.cpu, mem, readyAt := some (t + 1), retired := core.retired + 1 }
      if !full then return setCore w ci core
      return (setCore w ci { core with lastFrame := id, wakeFrame := "" }).emit p
        (frame "exec" [] (base () ++ [("address", toJson a), ("store", toJson value.toNat)]))
    let core := { core with
      cpu := step.cpu, readyAt := some (t + 1), retired := core.retired + 1,
      lastFrame := id, wakeFrame := "" }
    let detail := base () ++ [("address", toJson a), ("store", toJson value.toNat)]
    if a ≥ hostWindow && a < hostWindow + 16777216 then
      -- The host window is write only and takes byte, half and word stores.
      let (bytes, stored) := match op with
        | .sb => (1, value &&& 0xFF) | .sh => (2, value &&& 0xFFFF) | .sw => (4, value)
      w := { w with host := w.host.push (Json.mkObj [("core", ci), ("offset", a - hostWindow), ("bytes", bytes),
        ("value", stored.toNat), ("atBatch", outAt), ("frame", id)]) }
      return (setCore w ci core).emit p (frame "host" ["host"] (detail ++ [("offset", toJson (a - hostWindow))]))
    if op != .sw || address &&& 3 != 0 then
      return stop w { core with retired := core.retired - 1 } "fault" s!"control registers take aligned word stores ({hex32 address})"
    if a == 0x4000 then
      return (setCore w ci { core with timeCmp := value }).emit p (frame "write" [] (detail ++ [("register", toJson "timeCmp")]))
    if a == 0x4010 then
      if value &&& 1 == 0 then return (setCore w ci core).emit p (frame "write" [] (detail ++ [("register", toJson "done")]))
      -- The flag is sticky. The model stops stepping a core once its program has finished.
      let core := { core with done := true, stopped := some "done", readyAt := none }
      return (setCore w ci core).emit p (frame "done" ["host"] (detail ++ [("register", toJson "done")]))
    if a ≥ putWindow && a < putWindow + 4096 * 65536 then
      let node := (a - putWindow) / 65536
      let offset := ((a - putWindow) % 65536).toUInt32
      w := setCore w ci core
      if node < localNodes then
        if node < spec.channels.size then
          w := w.schedule (outAt + p.model.linkPipe) id (some pc.toNat) source (.put ci node offset value)
          return w.emit p (frame "put" [s!"{name}.link", channelPart p ci node]
            (detail ++ [("channel", toJson node), ("offset", toJson offset.toNat)]))
        w := w.fault t name s!"put to missing channel {node}"
        return w.emit p (frame "put" [s!"{name}.link"] (detail ++ [("channel", toJson node), ("dropped", true)]))
      w := w.schedule (outAt + p.model.hubDown) id (some pc.toNat) source (.hub ci node offset value)
      return w.emit p (frame "put" [s!"{name}.link", "hub"] (detail ++ [("node", toJson node), ("offset", toJson offset.toNat)]))
    return stop w { core with retired := core.retired - 1 } "fault" s!"store to unmapped address {hex32 address}"

/-- One cycle of core `ci`'s pipeline (`QControl.RiscQ.Pipe`): a redirect at register write,
    the instruction at execute entering, waiting or leaving (its architectural effect is `retire`),
    and every other stage moving on. The core acts again on the next cycle, or sleeps until its
    halted read can complete once nothing else in its pipeline can change. -/
def stepCore (p : Program) (w : World) (t ci : Nat) : World := Id.run do
  let cfg : PipeConfig := {}
  let spec := p.cores[ci]!
  let core := w.cores[ci]!
  if core.stopped.isSome then return w
  let mut pipe := core.pipe
  -- A misprediction at register write throws away stages 0–7 and steers fetch to the target.
  if let some target := pipe.redirect then
    pipe := Pipe.applyLearns cfg (Pipe.flush cfg pipe t target) t
    return setCore w ci { core with pipe, readyAt := some (t + 1) }
  let mut w := w
  let mut fired := false
  if let some slot := pipe.stages[7]! then
    let word := (readRam core.mem .lw slot.pc).getD 0
    let instr := decode word spec.withMul
    -- First cycle at execute: the halt this instruction will need.
    if pipe.exEnter.isNone then
      let step := exec core.cpu instr
      match step.access, instr with
      | .store .., _ =>
        let (accept, start, q) := Pipe.acceptStore cfg pipe t
        pipe := { q with exEnter := some t, exFire := some (accept + 1), exBus := some start }
      | .load .., _ =>
        let (_, resp, q) := Pipe.startLoad cfg pipe t
        pipe := { q with exEnter := some t, exFire := some resp }
      | _, .mulOp .. => pipe := { pipe with exEnter := some t, exFire := some (t + cfg.mulLatency) }
      | _, _ => pipe := { pipe with exEnter := some t, exFire := some t }
    if pipe.exFire.all (· ≤ t) then
      let outAt := (pipe.exBus.map (· + cfg.busToOut)).getD t
      let before := core.cpu.pc
      w := retire p (setCore w ci { core with pipe }) t ci outAt
      let after := w.cores[ci]!
      if after.wait == .none then
        fired := true
        -- The corrector (`BranchPlugin`): the true successor against the fetched prediction.
        let next := after.cpu.pc
        if next != slot.predNext then pipe := { pipe with redirect := some next }
        match instr with
        | .branch .. => pipe := Pipe.learn cfg pipe t slot (next != before + 4) next true
        | .jal .. | .jalr .. => pipe := Pipe.learn cfg pipe t slot true next false
        | _ => pure ()
        pipe := { pipe with exEnter := none, exFire := none, exBus := none }
  let core := w.cores[ci]!
  if core.stopped.isSome then return setCore w ci { core with pipe }
  let word := fun (pc : UInt32) ↦ (readRam core.mem .lw pc).getD 0
  let moved := Pipe.applyLearns cfg (Pipe.advance cfg pipe t fired word) t
  -- A core halted on a read whose pipeline can no longer change sleeps until the read can complete.
  let quiet := core.wait != .none && moved == pipe
  let readyAt := if quiet then core.readyAt else some (t + 1)
  return setCore w ci { core with pipe := moved, readyAt }

/-- Reset state. Every core starts at the base of its RAM with zeroed registers. -/
def initial (p : Program) : World :=
  let cores := p.cores.map fun c ↦
    let mem : Array UInt32 := c.image.map Nat.toUInt32 ++ Array.replicate (c.memWords - c.image.size) (0 : UInt32)
    let sinks := c.channels.zipIdx.filterMap fun (ch, i) ↦
      if ch.kind == "demod" then some ({ kind := "result", channel := i } : SinkState)
      else if ch.kind == "dio" then some ({ kind := "fifo", channel := i } : SinkState) else none
    let sources := Id.run do
      let mut table := Array.replicate c.memWords ""
      let mut current := ""
      let mut next := 0
      for i in [0:c.image.size] do
        while next < c.sourceMap.size && c.sourceMap[next]!.pc / 4 ≤ i do
          current := c.sourceMap[next]!.source
          next := next + 1
        table := table.set! i current
      return table
    ({ mem, sinks, sources,
       channels := c.channels.map fun ch ↦ { buffer := { table := Array.replicate ch.slots {} } } } : CoreState)
  -- Every core starts ready at cycle 0.
  let ready := (List.range cores.size).foldl (fun (h : Heap (Nat × Nat)) i ↦ h.push readyBefore (0, i)) {}
  let w : World := { cores, ready }
  p.dioInputs.foldl (fun w e ↦ w.schedule e.atBatch "" none none (.dioIn e.core e.channel e.levels)) w

/-- The next core to act: the least (ready cycle, index) entry that still matches its core. Entries left
    by earlier states are dropped on the way; the valid one stays, as the core may act again at that cycle. -/
private def nextCore (w : World) : World × Option (Nat × Nat) := Id.run do
  let mut ready := w.ready
  for _ in [0:w.ready.size + 1] do
    match ready.top? with
    | none => return ({ w with ready }, none)
    | some (r, i) =>
      let valid := match w.cores[i]? with
        | some c => c.stopped.isNone && c.readyAt == some r
        | none => false
      if valid then return ({ w with ready }, some (r, i))
      ready := ready.pop readyBefore
  return ({ w with ready }, none)

/-- Schematic placement on the two-region floorplan RISC-Q documents: cores in the left
    column, converter-edge channels in the DSP columns, converters at the right edge and the
    bound apparatus parts beyond it. Coordinates are tenths of a clock region of that
    floorplan, not millimetres. Each core takes a row tall enough for its converters, and the
    converter column lies beyond the widest core, so no two parts share a position. -/
def system (p : Program) : Json := Id.run do
  let mut parts : Array Json := #[]
  let mut links : Array Json := #[]
  let part := fun (id kind label : String) (x y : Int) ↦
    Json.mkObj [("id", id), ("kind", kind), ("label", label), ("position", toJson [x, y])]
  parts := parts.push (part "host" "host" "Host processor and result memory" (-15) 0)
  parts := parts.push (part "hub" "hub" "Board hub: groups, barriers, mailboxes" 6 (-10))
  let widest := p.cores.foldl (fun n c ↦ max n c.channels.size) 1
  let converterX : Int := 15 + 8 * widest + 4
  let mut converters : Array String := #[]
  let mut y : Int := 0
  for c in p.cores do
    parts := parts.push (part c.name "core" s!"RV32I core {c.name}" 0 y)
    parts := parts.push (part s!"{c.name}.link" "link" s!"Posted link, {p.model.linkPipe} stages each way" 6 y)
    parts := parts.push (part s!"{c.name}.inbox" "inbox" "Core-local sinks and mailboxes" 3 (y + 3))
    links := links.push (Json.mkObj [("id", s!"{c.name}.put"), ("from", c.name), ("to", s!"{c.name}.link")])
    links := links.push (Json.mkObj [("id", s!"{c.name}.hub"), ("from", s!"{c.name}.link"), ("to", "hub")])
    for (ch, j) in c.channels.zipIdx do
      let id := s!"{c.name}.{ch.name}"
      let x : Int := 15 + 8 * j
      parts := parts.push (part id ch.kind s!"{ch.kind} channel {ch.name}: {ch.slots} entries" x y)
      links := links.push (Json.mkObj [("id", s!"{id}.cmd"), ("from", s!"{c.name}.link"), ("to", id)])
      let converter := converterPart ch id
      if !converters.contains converter then
        converters := converters.push converter
        let kind := if ch.dac?.isSome then "dac" else if ch.adc?.isSome then "adc" else "pins"
        parts := parts.push (part converter kind converter converterX (y + 2 * j))
      links := links.push (Json.mkObj [("id", s!"{id}.out"), ("from", id), ("to", converter)])
      if ch.kind != "pulse" then
        links := links.push (Json.mkObj [("id", s!"{id}.report"), ("from", id), ("to", s!"{c.name}.inbox")])
    y := y + max 10 (2 * c.channels.size + 2)
  let mut devices : Array String := #[]
  for b in p.bindings do
    unless devices.contains b.part || converters.contains b.part do
      parts := parts.push (part b.part "device" b.part (converterX + 15) (3 * devices.size))
      devices := devices.push b.part
  return Json.mkObj [("basis", "schematic two-region floorplan, tenths of a clock region"),
    ("parts", toJson parts), ("links", toJson links)]

/-- Run until every core has stopped and no event is pending, or a budget is spent. -/
def run (p : Program) : Json := Id.run do
  let mut w := initial p
  let mut status := "quiescent"
  let mut now := 0
  let mut steps := 0
  for _ in [0:p.maxSteps] do
    steps := steps + 1
    let (w', core) := nextCore w
    w := w'
    let item := w.agenda.top?
    -- Converter-edge and link events apply before a core acts on the same cycle.
    let useItem : Bool := match item, core with
      | some it, some (r, _) => decide (it.cycle ≤ r)
      | some _, none => true
      | none, _ => false
    let cycle := if useItem then (item.map (·.cycle)).getD 0 else (core.map (·.1)).getD 0
    if item.isNone && core.isNone then break
    if cycle > p.maxBatches then
      status := "time limit"
      break
    if w.frames.size ≥ p.maxEvents then
      status := "event limit"
      break
    now := max now cycle
    if useItem then
      let some it := item | break
      w := applyItem p { w with agenda := w.agenda.pop itemBefore } it
    else
      let some (r, i) := core | break
      w := stepCore p w r i
    if steps == p.maxSteps then status := "step limit"
  let cores := w.cores.zipIdx.map fun ((c : CoreState), (i : Nat)) ↦ Json.mkObj [
    ("name", partOf p i), ("retired", c.retired), ("pc", c.cpu.pc.toNat), ("done", c.done),
    ("stopped", toJson c.stopped),
    ("waiting", c.stopped.isNone && c.wait != Wait.none),
    ("regs", toJson (c.cpu.regs.map UInt32.toNat)),
    ("channels", toJson (c.channels.zipIdx.map fun ((ch : ChannelState), (j : Nat)) ↦ Json.mkObj [
      ("part", channelPart p i j), ("buffer", bufferJson ch.buffer), ("freq", ch.freqNow),
      ("windows", ch.windows), ("dout", ch.dout), ("din", ch.din)])),
    ("sinks", toJson (c.sinks.map sinkJson))]
  let summary := Json.mkObj [
    ("status", status), ("elapsedBatches", now), ("elapsedPs", now * p.dspPeriodPs), ("steps", steps),
    ("cores", toJson cores), ("pulses", toJson w.pulses), ("tones", toJson w.tones),
    ("faults", toJson w.faults), ("host", toJson w.host),
    ("hub", Json.mkObj [("groups", toJson ((w.hubs.getD 0 ({} : HubState)).groups.map UInt32.toNat)),
      ("countMismatch", toJson (w.hubs.any (·.countMismatch))), ("served", toJson (w.hubs.foldl (fun (m : Nat) h ↦ m + h.served) 0)),
      ("maxWait", toJson (w.hubs.foldl (fun (m : Nat) h ↦ max m h.maxWait) 0)),
      ("peakWaiting", toJson (w.hubs.foldl (fun (m : Nat) h ↦ max m h.peakWaiting) 0)),
      ("boards", toJson p.boards),
      ("perBoard", toJson (w.hubs.map fun h ↦ Json.mkObj [("groups", toJson (h.groups.map UInt32.toNat)), ("served", h.served),
        ("maxWait", h.maxWait), ("peakWaiting", h.peakWaiting)]))])]
  let start := Json.mkObj [("pc", ramBase.toNat), ("timeRegister", p.timeOffset),
    ("coreTime", (p.coreTime 0).toNat)]
  return Json.mkObj [("program", toJson p), ("system", system p), ("initial", start),
    ("frames", toJson w.frames), ("summary", summary)]

end QControl.RiscQ
