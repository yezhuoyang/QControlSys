import QControl.Controller

/-! A discrete-event semantics for connected control components. Physical time is integral
picoseconds. Equal-time arrivals precede FPGA issue; all intercomponent links have positive delay. -/
namespace QControl.Fabric
open Lean

inductive Signal where
  | bit | address | word | voltageUv | frequencyHz | positionNm
  deriving FromJson, ToJson, DecidableEq, Repr

structure Sample where
  atPs : Nat
  value : Int
  deriving FromJson, ToJson

inductive Primitive where
  | fpga (clockPs : Nat)
  | ram (words : Array Int) (accessPs : Nat)
  | bus (widthBits beatPs : Nat)
  | busBuffer (inputRailMv outputRailMv : Nat)
  | dmaBurst (samples primed clockPs steadySamplePs observe : Nat)
  | dac (bits fullScaleUv : Nat)
  | clockedDac (bits fullScaleUv : Nat) (address : Option Nat)
  | spiDac81416 (channel stepPs slewStepUv : Nat)
  | rcFilter (stepPs alphaPpm : Nat)
  | waveformBoard (profile : Controller.Program)
  | affine (input output : Signal) (numerator : Int) (denominator : Nat) (offset : Int)
  | threshold (levelUv : Int)
  | switch (signal : Signal)
  | probe (signal : Signal)
  | stimulus (signal : Signal) (samples : Array Sample)
  deriving FromJson, ToJson

def Primitive.inputs : Primitive → List (String × Signal)
  | .fpga _ => [("sense", .bit), ("rx", .word)]
  | .ram .. => [("address", .address)]
  | .bus .. => [("a", .word), ("b", .word)]
  | .busBuffer .. => [("in", .word), ("address", .address), ("strobe", .bit)]
  | .dmaBurst .. => [("start", .bit)]
  | .dac .. => [("in", .word)]
  | .clockedDac _ _ addr => [("in", .word), ("strobe", .bit)] ++
      (if addr.isSome then [("address", .address)] else [])
  | .waveformBoard _ => [("start", .word)]
  | .spiDac81416 .. => [("csN", .bit), ("sclk", .bit), ("sdi", .bit)]
  | .rcFilter .. => [("in", .voltageUv)]
  | .affine i .. => [("in", i)]
  | .threshold _ => [("in", .voltageUv)]
  | .switch s => [("in", s), ("enable", .bit)]
  | .probe s => [("in", s)]
  | .stimulus .. => []

def Primitive.outputs : Primitive → List (String × Signal)
  | .fpga _ => [("address", .address), ("tx", .word), ("flag", .bit),
      ("csN", .bit), ("sclk", .bit), ("sdi", .bit)]
  | .ram .. | .bus .. => [("out", .word)]
  | .busBuffer .. => [("out", .word), ("address", .address), ("strobe", .bit)]
  | .dmaBurst .. => [("done", .bit), ("sample", .bit)]
  | .dac .. | .clockedDac .. | .waveformBoard _ => [("out", .voltageUv)]
  | .spiDac81416 .. | .rcFilter .. => [("out", .voltageUv)]
  | .affine _ o .. | .switch o => [("out", o)]
  | .threshold _ => [("out", .bit)]
  | .probe _ => []
  | .stimulus s _ => [("out", s)]

structure Part where
  id : String
  label : String
  model : Primitive
  centerMm : Array JsonNumber
  sizeMm : Array JsonNumber
  pcbGroup? : Option String := none
  displayForm? : Option String := none
  deriving FromJson, ToJson

structure Port where
  part : String
  port : String
  deriving FromJson, ToJson, BEq

structure Wire where
  id : String
  src : Port
  dst : Port
  delayPs : Nat
  servicePs? : Option Nat := none
  wordPinMap? : Option (Array Nat) := none
  deriving FromJson, ToJson

inductive Op where
  | write (port : String) (value : Int)
  | writeBus (address : Nat) (word : Int)
  | read (port : String)
  | writeAcc (port : String)
  | add (value : Int)
  | saveBit (slot : Nat)
  | loadBit (slot : Nat)
  | jz (target : Nat)
  | jump (target : Nat)
  | wait (ticks : Nat)
  | halt
  deriving FromJson, ToJson

structure Instruction where
  source : String
  op : Op
  atPs? : Option Nat := none
  deriving FromJson, ToJson

structure Image where
  controller : String
  code : Array Instruction
  deriving FromJson, ToJson

structure Program where
  kind : String
  version : Nat
  parts : Array Part
  wires : Array Wire
  images : Array Image
  maxEvents : Nat
  deriving FromJson, ToJson

private def signalValid : Signal → Int → Bool
  | .bit, v => v == 0 || v == 1
  | .word, v => -32768 ≤ v && v ≤ 32767
  | .address, v => 0 ≤ v && v < 65536
  | _, _ => true

private def positiveTime (v : Nat) := 0 < v && v ≤ 1000000000000

def Program.validate (p : Program) : Except String Unit := do
  unless p.kind == "component-machine" && p.version == 1 do throw "Unknown component machine version."
  unless 0 < p.parts.size && p.parts.size ≤ 256 && p.wires.size ≤ 1024 &&
    0 < p.maxEvents && p.maxEvents ≤ 20000 do throw "Machine size or event budget outside range."
  let ids := (p.parts.map Part.id ++ p.wires.map Wire.id).toList
  unless ids.Nodup && ids.all (fun id ↦ !id.isEmpty && id.length ≤ 100) do
    throw "All component and wire IDs must be nonempty and unique."
  for c in p.parts do
    if let some form := c.displayForm? then
      unless form == "oscilloscope" && (c.model matches .probe .voltageUv) do
        throw s!"{c.id}: oscilloscope geometry requires a voltage probe."
    unless c.pcbGroup?.all (fun g ↦ !g.isEmpty && g.length ≤ 100) do
      throw s!"{c.id}: invalid PCB group."
    unless c.centerMm.size == 3 && c.sizeMm.size == 3 && c.sizeMm.all (fun n ↦ n.mantissa > 0) do
      throw s!"{c.id}: supply a 3D center and positive dimensions in mm."
    if let .waveformBoard profile := c.model then profile.validate
    if let .stimulus sig samples := c.model then
      unless samples.size ≤ p.maxEvents do throw s!"{c.id}: stimulus exceeds the event budget."
      let mut prior : Option Nat := none
      for s in samples do
        unless s.atPs ≤ 9007199254740991 && prior.all (· < s.atPs) && signalValid sig s.value do
          throw s!"{c.id}: stimulus needs increasing, exact times and valid signal levels."
        prior := some s.atPs
    let valid := match c.model with
      | .fpga t => positiveTime t
      | .ram w t => !w.isEmpty && w.size ≤ 65536 && w.all (signalValid .word) && positiveTime t
      | .bus w t => 0 < w && w ≤ 1024 && positiveTime t
      | .busBuffer vi vo => 0 < vi && 0 < vo
      | .dmaBurst n p t s i => 0 < i && i ≤ n && n ≤ 10000000 && p ≤ n &&
          positiveTime t && t ≤ s && s ≤ 10000000
      | .dac b v => 2 ≤ b && b ≤ 16 && 0 < v && v ≤ 10000000
      | .clockedDac b v a => 2 ≤ b && b ≤ 16 && 0 < v && v ≤ 10000000 && a.all (· < 65536)
      | .spiDac81416 ch t dv => ch < 16 && positiveTime t && 0 < dv && dv ≤ 20000000
      | .rcFilter t a => positiveTime t && 0 < a && a ≤ 1000000
      | .affine _ _ _ d _ => d > 0
      | _ => true
    unless valid do throw s!"{c.id}: invalid primitive parameters."
  let mut driven := #[]
  for w in p.wires do
    let some a := p.parts.find? (·.id == w.src.part) | throw s!"{w.id}: unknown source."
    let some b := p.parts.find? (·.id == w.dst.part) | throw s!"{w.id}: unknown destination."
    let some s := a.model.outputs.lookup w.src.port | throw s!"{w.id}: unknown output {w.src.port}."
    unless b.model.inputs.lookup w.dst.port == some s do
      throw s!"{w.id}: incompatible input {w.dst.part}.{w.dst.port}, output has type {repr s}."
    unless positiveTime w.delayPs && !driven.contains w.dst do
      throw s!"{w.id}: each input accepts one driver and each wire needs positive delayPs."
    if let some service := w.servicePs? then
      unless positiveTime service do throw s!"{w.id}: invalid wire serialization interval."
    if let some pins := w.wordPinMap? then
      let width := if s == .bit then 1 else 16
      unless [Signal.bit, .address, .word].contains s && pins.size == width &&
          pins.all (· ≤ width) do
        throw s!"{w.id}: invalid {width}-bit conductor mapping."
    driven := driven.push w.dst
  let cpus := (p.parts.filter (fun c ↦ match c.model with | .fpga _ => true | _ => false)).map Part.id
  let owners := p.images.map Image.controller
  unless owners.toList.Nodup && cpus.size == owners.size do
    throw "Provide exactly one instruction image per FPGA."
  for image in p.images do
    let some c := p.parts.find? (·.id == image.controller) | throw "Unknown image controller."
    unless cpus.contains c.id && !image.code.isEmpty && image.code.size ≤ 16384 do
      throw s!"{c.id}: invalid instruction image."
    for i in image.code do
      unless !i.source.isEmpty do throw "Each instruction needs a source ID."
      let fail := s!"{i.source} on {c.id}: invalid operand or unwired port."
      if let some time := i.atPs? then
        let .fpga clock := c.model | throw fail
        unless time ≤ 9007199254740991 && time % clock == 0 do
          throw s!"{i.source}: scheduled issue at {time} ps lies outside the {clock} ps clock grid."
      match i.op with
      | .writeBus addr word =>
        unless signalValid .address addr && signalValid .word word &&
          ["address", "tx"].all (fun port ↦ p.wires.any (fun w ↦ w.src == ⟨c.id, port⟩)) do throw fail
      | .write port _ | .writeAcc port =>
        let some s := c.model.outputs.lookup port | throw fail
        unless p.wires.any (fun w ↦ w.src == ⟨c.id, port⟩) do throw fail
        if let .write _ value := i.op then unless signalValid s value do throw fail
      | .read port => unless driven.contains ⟨c.id, port⟩ do throw fail
      | .jz t | .jump t => unless t < image.code.size do throw fail
      | .wait t => unless t ≤ 1000000000 do throw fail
      | .saveBit s | .loadBit s => unless s < 256 do throw fail
      | _ => pure ()

/-- FIFO serialization of a 16-bit transfer. A beat belongs to one request at a time. -/
def busFinish (arrival free width beat : Nat) := max arrival free + ((16 + width - 1) / width) * beat

theorem busFinish_after_prior (arrival free width beat : Nat) :
    free ≤ busFinish arrival free width beat := by
  unfold busFinish
  omega

structure SpiInput where
  selected : Bool := false
  clockHigh : Bool := false
  dataBit : Nat := 0
  clocks : Nat := 0
  shift : Nat := 0
  selectEvent : Option Nat := none
  dataEvent : Option Nat := none
  deriving ToJson, Inhabited

structure State where
  pc : Nat := 0
  acc : Int := 0
  value : Int := 0
  sense : Int := 0
  rx : Int := 0
  freePs : Nat := 0
  halted : Bool := false
  last : Option Nat := none
  senseEvent : Option Nat := none
  rxEvent : Option Nat := none
  dataEvent : Option Nat := none
  issueEvent : Option Nat := none
  bits : List (Nat × Bool) := []
  spi? : Option SpiInput := none
  deriving ToJson, Inhabited

/-- A dedicated physical transmitter releases a frame before propagation finishes. -/
def txStart (issued priorRelease : Nat) : Nat := max issued priorRelease

theorem wire_frames_do_not_overlap (issued priorRelease : Nat) :
    priorRelease ≤ txStart issued priorRelease := Nat.le_max_right ..

theorem wire_arrival_after_send (issued priorRelease service flight : Nat) :
    issued ≤ txStart issued priorRelease + service + flight := by
  unfold txStart
  omega

/-- Decode a parallel payload using the physical source pin of each destination bit.
    Index 16 selects a zero padding bit. Address ports retain unsigned representation. -/
def decodeWordPins (value : Int) (pins : Array Nat) (unsigned : Bool) : Int :=
  let bits := (value.emod 65536).toNat
  let result := pins.toList.zipIdx.foldl (fun acc (src, dst) ↦
    acc + ((bits / 2 ^ src) % 2) * 2 ^ dst) 0
  if !unsigned && result ≥ 32768 then (result : Int) - 65536 else result

private def dacVoltage (bits fullScale : Nat) (v : Int) : Int :=
  let limit := (2 : Int) ^ (bits - 1)
  let code := Controller.clip limit (v / (2 : Int) ^ (16 - bits))
  (code * fullScale).tdiv limit

/-- The independent strobe latches the pending word on a low-to-high transition. -/
def strobeWord (previous next word : Int) : Option Int :=
  if previous == 0 && next == 1 then some word else none

theorem strobe_rise_latches (word : Int) : strobeWord 0 1 word = some word := rfl

theorem strobe_low_holds (previous word : Int) : strobeWord previous 0 word = none := by
  simp [strobeWord]

/-- Elapsed counter time at record n, with a prefilled FIFO followed by average memory service.
    The integer ceiling places the observation on the next PL clock edge. -/
def dmaRecordPs (n primed clockPs steadySamplePs : Nat) : Nat :=
  if n ≤ primed then n * clockPs
  else primed * clockPs + (((n - primed) * steadySamplePs + clockPs - 1) / clockPs) * clockPs

theorem dma_prefilled_records (n p t s : Nat) (h : n ≤ p) :
    dmaRecordPs n p t s = n * t := by simp [dmaRecordPs, h]

/-- Move toward a held target by at most the specified number of microvolts per step. -/
def approach (v target : Int) (limit : Nat) : Int :=
  if v ≤ target then min target (v + limit) else max target (v - limit)

/-- A rate-limited driver and the RC update below stay within the two endpoint voltages. -/
theorem approach_between (v target : Int) (n : Nat) :
    min v target ≤ approach v target n ∧ approach v target n ≤ max v target := by
  unfold approach
  split <;> omega

theorem approach_bounded_slew (v target : Int) (n : Nat) :
    v - n ≤ approach v target n ∧ approach v target n ≤ v + n := by
  unfold approach
  split <;> omega

/-- Rounded, sampled one-pole response. A final microvolt step avoids a rounding dead band. -/
def rcNext (v target : Int) (alphaPpm : Nat) : Int :=
  approach v target (max 1 (((target - v).natAbs * alphaPpm + 500000) / 1000000))

theorem rcNext_between (v target : Int) (a : Nat) :
    min v target ≤ rcNext v target a ∧ rcNext v target a ≤ max v target :=
  approach_between ..

/-- Stand-alone 24-bit, CRC-disabled, asynchronous straight-binary write in the ±10 V range.
    The don't-care bit is ignored. Other addresses and reads leave this channel unchanged. -/
def spiTarget (channel clocks frame : Nat) : Option Int :=
  if clocks == 24 && frame / 8388608 == 0 && (frame / 65536) % 64 == 16 + channel then
    some (((frame % 65536 : Nat) : Int) * 20000000 / 65536 - 10000000)
  else none

theorem spi_incomplete_holds (ch clocks frame : Nat) (h : clocks < 24) :
    spiTarget ch clocks frame = none := by simp [spiTarget, Nat.ne_of_lt h]

private structure Transfer where
  issuedPs : Nat
  startPs : Nat
  releasePs : Nat
  priorEvent : Option Nat
  deriving ToJson, Inhabited

private inductive Action where
  | issue
  | analogTick
  | dmaRecord (ordinal : Nat)
  | deliver (wire : Nat) (value : Int) (transfer : Option Transfer)
  | emit (value : Int)
  | board (launch : Nat) (frame : Json)
  deriving Inhabited

private structure Job where
  time : Nat
  part : Nat
  action : Action
  parent : Option Nat
  source : String
  deriving Inhabited

private def Job.priority (j : Job) := match j.action with
  | .analogTick => 0 | .issue => 2 | _ => 1

private structure OrderKey where
  time : Nat
  priority : Nat
  serial : Nat
  deriving Ord

private structure Kernel where
  states : Array State
  queue : Std.TreeMap OrderKey Job := {}
  serial : Nat := 0
  frames : Array Json := #[]
  boardEvents : Std.TreeMap String Nat := {}
  wireReservations : Std.TreeMap Nat (Nat × Nat) := {}

private def enqueue (k : Kernel) (j : Job) : Kernel :=
  { k with queue := k.queue.insert ⟨j.time, j.priority, k.serial⟩ j, serial := k.serial + 1 }

private def schedule (k : Kernel) (j : Job) : Except String Kernel := do
  unless j.time ≤ 9007199254740991 do throw "Time exceeds the exact picosecond trace range."
  return enqueue k j

private def executeReady (p : Program) (k : Kernel) (j : Job) : Except String Kernel := do
  let some c := p.parts[j.part]? | throw "Unknown scheduled part."
  let mut state := k.states[j.part]!
  let mut k := k
  let id := k.frames.size
  let mut parents := j.parent.toList ++ state.last.toList
  let mut source := j.source
  let mut label := ""
  let mut wire : Option String := none
  let mut atPc : Option Nat := none
  let mut send : Option (String × Int) := none
  let mut simultaneous : List (String × Int) := []
  let mut received : Option (String × Int) := none
  let mut native : Option Json := none
  let mut transport : Option Transfer := none
  let mut sourceWord : Option Int := none
  match j.action with
  | .issue =>
    let .fpga clock := c.model | throw "Issue requires FPGA."
    let some image := p.images.find? (·.controller == c.id) | throw "Missing FPGA image."
    let some ins := image.code[state.pc]? | throw s!"{c.id}: execution fell outside its instruction image."
    source := ins.source
    atPc := some state.pc
    parents := parents ++ state.issueEvent.toList
    state := { state with pc := state.pc + 1, issueEvent := some id }
    let mut ticks := 1
    match ins.op with
    | .write port value => label := "write " ++ port; send := some (port, value)
    | .writeBus addr word =>
      label := "write address and data"; simultaneous := [("address", addr)]; send := some ("tx",word)
    | .writeAcc port => label := "write " ++ port; send := some (port, state.acc)
    | .read port =>
      label := "read " ++ port
      let sense := port == "sense"
      parents := parents ++ (if sense then state.senseEvent else state.rxEvent).toList
      state := { state with acc := if sense then state.sense else state.rx }
    | .add v =>
      label := "add"
      state := { state with acc := (state.acc + v + 32768).emod 65536 - 32768 }
    | .saveBit slot =>
      label := "store bit"
      unless signalValid .bit state.acc do throw s!"{source}: accumulator does not contain a bit."
      state := { state with bits := (slot, state.acc != 0) :: state.bits.filter (·.1 != slot) }
    | .loadBit slot =>
      label := "load bit"
      let some b := state.bits.lookup slot | throw s!"{source}: classical bit {slot} is uninitialized."
      state := { state with acc := if b then 1 else 0 }
    | .wait n => label := "wait"; ticks := 1 + n
    | .jump t => label := "jump"; state := { state with pc := t }
    | .jz t =>
      label := "branch if zero"
      if state.acc == 0 then state := { state with pc := t }
    | .halt => label := "halt"; state := { state with halted := true }
    unless state.halted do
      k ← schedule k ⟨j.time + ticks * clock, j.part, .issue, some id, source⟩
  | .emit v => label := "output ready"; send := some ("out", v)
  | .board launch frame =>
    native := some frame
    label ← (← frame.getObjVal? "op").getStr?
    let localId ← (← frame.getObjVal? "id").getStr?
    for parent in ← (← frame.getObjVal? "parents").getArr? do
      let key := s!"{launch}/{← parent.getStr?}"
      if let some pid := k.boardEvents.get? key then parents := pid :: parents
    k := { k with boardEvents := k.boardEvents.insert s!"{launch}/{localId}" id }
    let innerState ← frame.getObjVal? "state"
    if label == "convert" || label == "underrun" then
      send := some ("out", ← (← innerState.getObjVal? "outputUv").getInt?)
    if label == "stop" then
      throw s!"{source}: {c.id} stopped: {← innerState.getObjVal? "reason"}."
  | .dmaRecord ordinal =>
    let .dmaBurst n .. := c.model | throw "Expected a DMA burst."
    state := { state with acc := ordinal }
    label := s!"FIFO record {ordinal} of {n}"
    send := some (if ordinal == n then "done" else "sample", 1)
  | .analogTick =>
    let target := state.rx
    if let some n := state.rxEvent then
      if let some frame := k.frames[n]? then source ← (← frame.getObjVal? "source").getStr?
    let (period, value, op) ← match c.model with
      | .spiDac81416 _ t dv => pure (t, approach state.value target dv, "slew DAC output")
      | .rcFilter t a => pure (t, rcNext state.value target a, "advance RC output")
      | _ => throw "Expected a sampled analog stage."
    label := op
    parents := parents ++ state.rxEvent.toList
    send := some ("out", value)
    let next := if value == target then 0 else j.time + period
    state := { state with freePs := next }
    if next != 0 then k ← schedule k ⟨next, j.part, .analogTick, some id, source⟩
  | .deliver n v reservation =>
    transport := reservation
    if let some r := reservation then parents := parents ++ r.priorEvent.toList
    let some w := p.wires[n]? | throw "Unknown scheduled wire."
    if w.wordPinMap?.isSome then sourceWord := some v
    let v := w.wordPinMap?.elim v (fun pins ↦
      decodeWordPins v pins (c.model.inputs.lookup w.dst.port == some .address))
    wire := some w.id
    received := some (w.dst.port, v)
    label := "receive " ++ w.dst.port
    match c.model with
    | .fpga _ =>
      if w.dst.port == "sense" then state := { state with sense := v, senseEvent := some id }
      else state := { state with rx := v, rxEvent := some id }
    | .ram words latency =>
      let some word := words[v.toNat]? | throw s!"{source}: {c.id} RAM address {v} outside image."
      k ← schedule k ⟨j.time + latency, j.part, .emit word, some id, source⟩
    | .bus width beat =>
      let finish := busFinish j.time state.freePs width beat
      state := { state with freePs := finish }
      k ← schedule k ⟨finish, j.part, .emit v, some id, source⟩
    | .busBuffer .. =>
      let port := if w.dst.port == "in" then "out" else w.dst.port
      label := "buffer " ++ w.dst.port
      send := some (port, v)
    | .dmaBurst n p clock service observe =>
      if v == 1 then
        unless state.freePs ≤ j.time do throw s!"{c.id}: DMA still active."
        let finish := j.time + dmaRecordPs n p clock service
        state := { state with freePs := finish }
        if observe < n then
          k ← schedule k ⟨j.time + dmaRecordPs observe p clock service, j.part,
            .dmaRecord observe, some id, source⟩
        k ← schedule k ⟨finish, j.part, .dmaRecord n, some id, source⟩
    | .waveformBoard profile =>
      unless j.time ≥ state.freePs do throw s!"{source}: {c.id} triggered while busy."
      let run := Controller.run { profile with inputWord := (v.emod 65536).toNat }
      for frame in ← (← run.getObjVal? "frames").getArr? do
        let delta : Nat ← match frame.getObjVal? "atPs" with
          | .ok ps => ps.getNat?
          | .error _ => do pure ((← (← frame.getObjVal? "atNs").getNat?) * 1000)
        k ← schedule k ⟨j.time + delta, j.part, .board id frame, some id, source⟩
        state := { state with freePs := j.time + delta }
    | .dac bits fullScale =>
      send := some ("out", dacVoltage bits fullScale v)
    | .clockedDac bits fullScale addr =>
      if w.dst.port == "in" then
        state := { state with rx := v, rxEvent := some id }
      else if w.dst.port == "address" then
        state := { state with acc := v, dataEvent := some id }
      else
        if addr.all (fun a ↦ state.dataEvent.isSome && a == state.acc.toNat) then
          if let some word := strobeWord state.sense v state.rx then
            parents := parents ++ state.rxEvent.toList ++ state.dataEvent.toList
            send := some ("out", dacVoltage bits fullScale word)
            label := "latch DAC word"
        state := { state with sense := v, senseEvent := some id }
    | .affine _ _ num den offset => send := some ("out", (v * num).tdiv den + offset)
    | .spiDac81416 ch .. =>
      let mut spi := state.spi?.getD {}
      if w.dst.port == "sdi" then
        spi := { spi with dataBit := v.toNat, dataEvent := some id }
      else if w.dst.port == "sclk" then
        if spi.selected && spi.clockHigh && v == 0 && spi.clocks < 24 then
          spi := { spi with shift := 2 * spi.shift + spi.dataBit, clocks := spi.clocks + 1 }
          parents := parents ++ spi.dataEvent.toList ++ spi.selectEvent.toList
          label := "shift SDI bit"
        spi := { spi with clockHigh := v == 1 }
      else if v == 0 && !spi.selected then
        spi := { spi with selected := true, clocks := 0, shift := 0, selectEvent := some id }
        label := "select SPI DAC"
      else if v == 1 && spi.selected then
        if let some target := spiTarget ch spi.clocks spi.shift then
          state := { state with rx := target, rxEvent := some id }
          label := "commit SPI DAC word"
        else label := "ignore SPI frame"
        spi := { spi with selected := false }
      state := { state with spi? := some spi }
    | .rcFilter .. =>
      state := { state with rx := v, rxEvent := some id }
    | .threshold level => send := some ("out", if v ≥ level then 1 else 0)
    | .switch _ =>
      if w.dst.port == "enable" then state := { state with sense := v, senseEvent := some id }
      else state := { state with rx := v, dataEvent := some id }
      parents := parents ++ state.senseEvent.toList ++ state.dataEvent.toList
      send := some ("out", if state.sense == 0 then 0 else state.rx)
    | .probe _ => pure ()
    | .stimulus .. => throw "A stimulus has no input."
    match c.model with
    | .rcFilter period _ | .spiDac81416 _ period _ =>
      if state.freePs == 0 && state.value != state.rx then
        let next := (j.time / period + 1) * period
        state := { state with freePs := next }
        k ← schedule k ⟨next, j.part, .analogTick, some id, source⟩
    | .clockedDac .. => pure ()
    | _ => state := { state with value := v }
  let outputs := simultaneous ++ send.toList
  for (port, value) in outputs do
    let some sig := c.model.outputs.lookup port | throw "Invalid output."
    unless signalValid sig value do throw s!"{source}: {c.id}.{port} value {value} outside type range."
    state := { state with value }
    for (w, i) in p.wires.toList.zipIdx do
      if w.src == ⟨c.id, port⟩ then
        let dst := p.parts.findIdx (·.id == w.dst.part)
        let mut release := j.time
        let mut reservation := none
        if let some service := w.servicePs? then
          let prior := k.wireReservations.get? i
          let start := txStart j.time ((prior.map Prod.fst).getD 0)
          release := start + service
          let blockedBy := if start > j.time then prior.map Prod.snd else none
          reservation := some ⟨j.time, start, release, blockedBy⟩
          k := { k with wireReservations := k.wireReservations.insert i (release, id) }
        k ← schedule k ⟨release + w.delayPs, dst, .deliver i value reservation, some id, source⟩
  state := { state with last := some id }
  let frame := Json.mkObj [("id", toJson id), ("atPs", toJson j.time), ("part", toJson c.id),
    ("wire", toJson wire), ("op", toJson label), ("source", toJson source), ("pc", toJson atPc),
    ("received", toJson received), ("emitted", toJson send), ("native", toJson native),
    ("parents", toJson ((parents.filter (· < id)).eraseDups)), ("state", toJson state)]
  let frame := transport.elim frame (fun t ↦ frame.setObjVal! "transport" (toJson t))
  let frame := if simultaneous.isEmpty then frame else frame.setObjVal! "outputs" (toJson outputs)
  let frame := sourceWord.elim frame (fun v ↦ frame.setObjVal! "transmittedValue" (toJson v))
  return { k with states := k.states.set! j.part state, frames := k.frames.push frame }

/-- A scheduled issue may retire only on its requested clock edge. -/
def issueOrder (now target : Nat) : Ordering := compare now target

theorem issueOrder_ready_iff (now target : Nat) :
    issueOrder now target = .eq ↔ now = target := by
  simp [issueOrder]

private def step (p : Program) (k : Kernel) (j : Job) : Except String Kernel := do
  if let .issue := j.action then
    let some c := p.parts[j.part]? | throw "Unknown scheduled FPGA."
    let state := k.states[j.part]!
    let ins := (p.images.find? (·.controller == c.id)).bind (fun im ↦ im.code[state.pc]?)
    if let some time := ins.bind Instruction.atPs? then
      let source := (ins.map Instruction.source).getD j.source
      match issueOrder j.time time with
      | .gt => throw s!"{source}: missed issue at {time} ps on {c.id}, ready at {j.time} ps."
      | .lt =>
        let id := k.frames.size
        let next := { state with last := some id }
        let frame := Json.mkObj [("id", toJson id), ("atPs", toJson j.time), ("part", toJson c.id),
          ("source", toJson source), ("op", toJson "await scheduled issue"), ("pc", toJson state.pc),
          ("scheduledPs", toJson time), ("wire", Json.null), ("state", toJson next),
          ("parents", toJson ((j.parent.toList ++ state.last.toList).eraseDups))]
        return enqueue { k with states := k.states.set! j.part next, frames := k.frames.push frame }
          ⟨time, j.part, .issue, some id, source⟩
      | .eq => pure ()
  executeReady p k j

def run (p : Program) : Except String Json := do
  p.validate
  let initial := p.parts.map fun part ↦
    if part.model matches .spiDac81416 .. then ({ spi? := some {} } : State) else {}
  let mut k : Kernel := { states := initial }
  let mut fault : Option String := none
  for (c, i) in p.parts.toList.zipIdx do
    if let .fpga _ := c.model then k := enqueue k ⟨0, i, .issue, none, ""⟩
    if let .stimulus _ samples := c.model then
      for (s, n) in samples.toList.zipIdx do
        k := enqueue k ⟨s.atPs, i, .emit s.value, none, s!"stimulus/{c.id}/{n}"⟩
  for _ in [0:p.maxEvents] do
    let some (key, job) := k.queue.minEntry? | break
    let pending := { k with queue := k.queue.erase key }
    match step p pending job with
    | .ok next => k := next
    | .error detail =>
      let some part := p.parts[job.part]? | throw detail
      let state := k.states[job.part]!
      let issue := match job.action with | .issue => true | _ => false
      let wire := match job.action with | .deliver i _ _ => (p.wires[i]?).map Wire.id | _ => none
      let ins := (p.images.find? (·.controller == part.id)).bind (fun im ↦ im.code[state.pc]?)
      let source := if issue then (ins.map Instruction.source).getD job.source else job.source
      let frame := Json.mkObj [("id", toJson k.frames.size), ("atPs", toJson job.time),
        ("source", toJson source), ("op", toJson "fault"), ("detail", toJson detail),
        ("wire", toJson wire), ("pc", toJson (if issue then some state.pc else none)),
        ("parents", toJson ((job.parent.toList ++ state.last.toList).eraseDups)),
        ("part", toJson part.id), ("state", toJson state)]
      k := { pending with frames := k.frames.push frame }
      fault := some detail
      break
  let stop := if fault.isSome then "fault" else if k.queue.isEmpty then "completed" else "event limit"
  return Json.mkObj [("program", toJson p), ("initial", toJson initial), ("frames", toJson k.frames),
    ("stop", toJson stop)]

end QControl.Fabric
