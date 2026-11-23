import Lean

/-! Clocked waveform controller. A single clock drives a sequencer, a word-packed DMA bus
    and a buffered DAC. At coincident edges the DAC consumes first, the bus commits second,
    and the sequencer issues last. A just-written sample cannot bypass the FIFO. -/
namespace QControl.Controller
open Lean

inductive Instruction where
  | load (value : Int) | add (value : Int) | jnz (target : Nat) | jump (target : Nat)
  | dma (address count : Nat) | wait (ticks : Nat) | play (count : Nat)
  | playTriggered (count : Nat) | halt
  deriving FromJson, ToJson, Repr

structure Program where
  kind : String
  version : Nat
  clockNs : Nat
  clockSubNsPs? : Option Nat := none
  busEvery : Nat
  busBits : Nat
  grantPattern : List Bool
  fifoWords : Nat
  sampleEvery : Nat
  dacBits : Nat
  fullScaleUv : Nat
  gainPermille : Int
  firQ15 : List Int
  inputWord : Nat
  memory : List Int
  code : Array Instruction
  maxCycles : Nat
  deriving FromJson, ToJson

def Program.clockPs (p : Program) := 1000 * p.clockNs + p.clockSubNsPs?.getD 0

/-- JSON decimal nanoseconds represented with exact integer picoseconds. -/
def nanoseconds (ps : Nat) : Json :=
  if ps % 1000 = 0 then toJson (ps / 1000) else Json.num ⟨(ps : Int), 3⟩

def Program.validate (p : Program) : Except String Unit := do
  unless p.kind == "waveform-controller" && [1,2].contains p.version do throw "Unknown controller version."
  unless 0 < p.clockPs && p.clockPs ≤ 10000000 && p.clockSubNsPs?.getD 0 < 1000 &&
      0 < p.busEvery && p.busEvery ≤ 128 &&
      0 < p.sampleEvery && p.sampleEvery ≤ 128 do throw "Use positive clock and divider values within range."
  unless [16,32,64].contains p.busBits && p.busBits / 16 ≤ p.fifoWords && p.fifoWords ≤ 32 do
    throw "Use a 16, 32 or 64 bit bus and a FIFO of one full beat to 32 words."
  unless !p.grantPattern.isEmpty && p.grantPattern.length ≤ 64 do throw "Use 1–64 arbitration slots."
  unless 2 ≤ p.dacBits && p.dacBits ≤ 16 && 0 < p.fullScaleUv && p.fullScaleUv ≤ 10000000 &&
      p.gainPermille.natAbs ≤ 4000 do throw "Invalid DAC resolution, voltage range or gain."
  unless !p.firQ15.isEmpty && p.firQ15.length ≤ 8 && (p.firQ15.map Int.natAbs).sum ≤ 65536 do
    throw "Use 1–8 signed Q15 taps with total absolute weight at most 65536."
  unless p.inputWord < 65536 && !p.memory.isEmpty && p.memory.length ≤ 256 &&
      p.memory.all (fun x ↦ -32768 ≤ x && x ≤ 32767) do throw "Invalid 16-bit input or waveform RAM."
  let budget := if p.version == 2 then 4096 else 256
  unless !p.code.isEmpty && p.code.size ≤ 64 && 0 < p.maxCycles && p.maxCycles ≤ budget do
    throw s!"Use 1–64 instructions and a run budget of 1–{budget} cycles."
  for ins in p.code do
    match ins with
    | .jnz t | .jump t => unless t < p.code.size do throw "Branch target is outside instruction RAM."
    | .dma a n => unless n > 0 && a + n ≤ p.memory.length do throw "DMA range is outside waveform RAM."
    | .play n => unless n > 0 && n ≤ 256 do throw "PLAY count must be 1–256."
    | .playTriggered n => unless p.version == 2 && n > 0 && n ≤ 256 do
        throw "Triggered playback requires a version 2 profile and 1–256 samples."
    | .wait n => unless n ≤ budget do throw s!"WAIT count must be 0–{budget}."
    | .load n | .add n => unless -32768 ≤ n && n ≤ 65535 do throw "Immediate is outside the 16-bit range."
    | .halt => pure ()

structure Word where
  address : Nat
  pcm : Int
  producer : String
  deriving ToJson

structure State where
  pc : Nat := 0
  acc : Nat := 0
  wake : Nat := 0
  halted : Bool := false
  done : Bool := false
  reason : String := ""
  dmaAddress : Nat := 0
  dmaLeft : Nat := 0
  playLeft : Nat := 0
  fifo : List Word := []
  beats : Nat := 0
  words : Nat := 0
  denied : Nat := 0
  backpressure : Nat := 0
  samples : Nat := 0
  underruns : Nat := 0
  clipped : Nat := 0
  lastAddress : Option Nat := none
  pcm : Int := 0
  dacCode : Int := 0
  idealUv : Int := 0
  outputUv : Int := 0
  historyUv : List Int := []
  playOrigin? : Option Nat := none
  deriving ToJson

def initial (p : Program) : State := { acc := p.inputWord }

/-- Signed PCM, integer gain, truncation to the DAC width, then saturation. -/
def rawCode (p : Program) (pcm : Int) : Int :=
  ((pcm * p.gainPermille).tdiv 1000) / (2 : Int) ^ (16 - p.dacBits)

def clip (limit code : Int) : Int := max (-limit) (min (limit - 1) code)

theorem clip_within_rails (limit code : Int) (h : 0 < limit) :
    -limit ≤ clip limit code ∧ clip limit code < limit := by
  unfold clip
  omega

def burstWords (p : Program) (s : State) := min (p.busBits / 16) s.dmaLeft

/-- A bus beat commits as one transaction. A stalled beat retains its DMA address. -/
def commitBeat (capacity : Nat) (s : State) (data : List Word) : String × State :=
  if s.fifo.length + data.length > capacity then
    ("backpressure", { s with backpressure := s.backpressure + 1 })
  else
    ("beat", { s with
      fifo := s.fifo ++ data, beats := s.beats + 1, words := s.words + data.length,
      dmaLeft := s.dmaLeft - data.length, dmaAddress := s.dmaAddress + data.length })

theorem commitBeat_preserves_capacity (capacity : Nat) (s : State) (data : List Word)
    (before : s.fifo.length ≤ capacity) : (commitBeat capacity s data).2.fifo.length ≤ capacity := by
  unfold commitBeat
  split <;> simp_all

theorem backpressure_preserves_address (capacity : Nat) (s : State) (data : List Word)
    (full : s.fifo.length + data.length > capacity) :
    (commitBeat capacity s data).2.dmaAddress = s.dmaAddress := by
  simp [commitBeat, full]

structure Frame where
  id : String
  atNs : Json
  op : String
  part : String
  targets : List String
  parents : List String
  sourcePc : Option Nat
  state : State
  atPs? : Option Nat := none
  deriving ToJson

private structure Machine where
  s : State
  frames : Array Frame := #[]
  prevCpu : String := ""
  prevBus : String := ""
  prevDac : String := ""
  dmaIssue : String := ""
  playIssue : String := ""
  dmaPc : Option Nat := none
  playPc : Option Nat := none

private def event (m : Machine) (p : Program) (cycle : Nat) (id op part : String)
    (targets parents : List String) (pc : Option Nat) (s : State) : Machine :=
  let ps := cycle * p.clockPs
  { m with s, frames := m.frames.push ⟨id, nanoseconds ps, op, part, targets,
      (parents.filter (!·.isEmpty)).eraseDups, pc, s, p.clockSubNsPs?.map (fun _ ↦ ps)⟩ }

private def sample (p : Program) (c : Nat) (m : Machine) : Machine := Id.run do
  let s := m.s
  if s.playLeft == 0 || (c - s.playOrigin?.getD 0) % p.sampleEvery != 0 then return m
  let word := s.fifo.head?
  let pcm := word.map Word.pcm |>.getD 0
  let limit := (2 : Int) ^ (p.dacBits - 1)
  let raw := rawCode p pcm
  let code := clip limit raw
  let uv := (code * p.fullScaleUv).tdiv limit
  let history := (uv :: s.historyUv).take p.firQ15.length
  let out := (history.zipWith (· * ·) p.firQ15).sum.tdiv 32768
  let next := { s with
    playLeft := s.playLeft - 1, fifo := s.fifo.drop 1,
    samples := s.samples + 1, underruns := s.underruns + (if word.isNone then 1 else 0),
    clipped := s.clipped + (if code != raw then 1 else 0), lastAddress := word.map Word.address,
    pcm, dacCode := code, idealUv := uv, outputUv := out, historyUv := history }
  let id := s!"dac-{c}"
  let nextM := event m p c id (if word.isNone then "underrun" else "convert") "dac" ["analog"]
    [m.playIssue, m.prevDac, (word.map Word.producer).getD m.prevBus] m.playPc next
  return { nextM with prevDac := id }

private def transfer (p : Program) (c : Nat) (m : Machine) : Machine := Id.run do
  let s := m.s
  if s.dmaLeft == 0 || c % p.busEvery != 0 then return m
  let id := s!"bus-{c}"
  let parents := [m.dmaIssue, m.prevBus, m.prevDac]
  let n := burstWords p s
  let grant := p.grantPattern[(c / p.busEvery) % p.grantPattern.length]?.getD false
  let (op, next) := if !grant then ("denied", { s with denied := s.denied + 1 })
    else
      let data := ((p.memory.drop s.dmaAddress).take n).zipIdx.map fun (x, i) ↦
        (⟨s.dmaAddress + i, x, id⟩ : Word)
      commitBeat p.fifoWords s data
  let nextM := event m p c id op "dac-bus" ["controller", "dac"] parents m.dmaPc next
  return { nextM with prevBus := id }

private def issue (p : Program) (c : Nat) (m : Machine) : Machine := Id.run do
  let s := m.s
  if s.halted || s.done || c < s.wake || s.playLeft > 0 then return m
  let id := s!"cpu-{c}"
  let pc := some s.pc
  let emit := fun op targets (next : State) ↦
    { (event m p c id op "controller" targets [m.prevCpu, m.prevDac, m.prevBus] pc next)
      with prevCpu := id }
  let advance := { s with pc := s.pc + 1 }
  match p.code[s.pc]? with
  | none => return emit "fault" [] { s with done := true, reason := "PC outside instruction RAM" }
  | some (.load v) => return emit "load" [] { advance with acc := (v % 65536).toNat }
  | some (.add v) => return emit "add" [] { advance with acc := ((s.acc : Int) + v).emod 65536 |>.toNat }
  | some (.jnz target) => return emit "jnz" [] { advance with pc := if s.acc != 0 then target else advance.pc }
  | some (.jump target) => return emit "jump" [] { advance with pc := target }
  | some (.wait ticks) => return emit "wait" [] { advance with wake := c + 1 + ticks }
  | some (.dma a n) =>
    if s.dmaLeft > 0 then return emit "dmaBusy" ["dac-bus"] s
    return { (emit "dma" ["dac-bus"] { advance with dmaAddress := a, dmaLeft := n })
      with dmaPc := pc, dmaIssue := id }
  | some (.play n) => return { (emit "play" ["dac"] { advance with playLeft := n, playOrigin? := none })
      with playPc := pc, playIssue := id }
  | some (.playTriggered n) =>
    return { (emit "playTriggered" ["dac"] { advance with playLeft := n, playOrigin? := some c })
      with playPc := pc, playIssue := id }
  | some .halt => return emit "halt" [] { s with halted := true }

/-- A capture records complete edge intervals. HALT retires after pending DMA completes. -/
def run (p : Program) (sampleCapture : Bool := false) : Json := Id.run do
  let mut m : Machine := { s := initial p }
  let mut cycles := 0
  for c in [0:p.maxCycles] do
    cycles := c + 1
    m := issue p c (transfer p c (sample p c m))
    if m.s.done || (m.s.halted && m.s.dmaLeft == 0) then break
    if p.version == 2 && m.frames.size ≥ 1024 then
      m := { m with s := { m.s with done := true, reason := "event limit" } }
      break
  let normal := m.s.halted && m.s.dmaLeft == 0
  let reason := if m.s.done then m.s.reason else if normal then "halted" else "cycle limit"
  let op := if normal then "finish" else "stop"
  m := event m p cycles "end" op "controller" [] [m.prevCpu, m.prevBus, m.prevDac] none
    { m.s with reason, done := true }
  let summary := Json.mkObj [("elapsedNs", nanoseconds (cycles * p.clockPs)),
    ("busSlots", toJson ((cycles + p.busEvery - 1) / p.busEvery)),
    ("payloadBytes", toJson (m.s.words * 2)), ("acceptedBeats", toJson m.s.beats),
    ("samples", toJson m.s.samples), ("underruns", toJson m.s.underruns), ("stop", toJson reason)]
  let frames := if sampleCapture then m.frames.filter (fun f ↦ f.op == "convert" || f.op == "underrun")
    else m.frames
  return Json.mkObj [("program", toJson p), ("initial", toJson (initial p)),
    ("frames", toJson frames), ("summary", summary)]

end QControl.Controller
