import QControl.RiscQ.Rv32

/-! Cycle model of one RISC-Q control core's pipeline, as `PulseTableSoc` builds it.

    The architecture of each instruction is `QControl.RiscQ.Rv32`. This file states when each
    instruction leaves the execute stage, cycle by cycle, following the RTL of
    `src/riscq/riscv/` in RISC-Q (github.com/Wu-Quantum-Application-System-Group/RISC-Q, commit
    243d814) with the parameters `PulseTableSoc.scala` uses: `RiscqParam(gshareMem, csrWarl,
    aluNoFastForward, aluResultOneHot)` with `fetchLatency = 4`, the URAM instruction and data
    RAM (read latency 3), and the `RiscqFiber` data path (`PostedStoreShim` depth 4, full stream
    pipes on both buses).

    Stages (`RiscqParam`): 0 PC and fetch fork, 4 fetch join, 5 decode, 6 register read and
    interlock, 7 execute, 8 register write and redirect. A skid buffer (`S2MLink`) sits after the
    stage 5 register (`skidAfter = fetchLatency`).

    Every constant below names the RTL it comes from. The model is checked instruction by
    instruction against a Verilator simulation of the same RTL (`riscq/rtl.mjs`,
    `validation/riscq/rtl/`): the commit cycle of each instruction must be the RTL's.

    Boundary: CSR instructions, traps and interrupts are not modeled (the firmware uses none). -/
namespace QControl.RiscQ

/-- Pipeline constants of the SoC's core build, with their RTL source. -/
structure PipeConfig where
  /-- `FetchPlugin`: `idCount = 1 << log2Up(joinAt − forkAt + 1)` with joinAt − forkAt = 4. -/
  fetchIds : Nat := 8
  /-- Fetch request to response: `StreamPipe.FULL` on the request (1) + URAM read latency
      `pipeNum + 2` = 3 (`RiscvSoc.scala`) + `StreamPipe.FULL` on the response (1). Measured 5. -/
  fetchLatency : Nat := 5
  /-- Stage index of the fetch join (`fetchDataAt = pcAt + fetchLatency`, fetchLatency = 4). -/
  joinAt : Nat := 4
  /-- `executeAt = decodeAt + 2`. -/
  executeAt : Nat := 7
  /-- `BtbPlugin`: `btbSets` (2), direct mapped on PC bits [2, 2 + log2 sets). -/
  btbSets : Nat := 2
  /-- `GSharePlugin`: `gshareHistoryWidth` (6). -/
  gshareWidth : Nat := 6
  /-- `MulPlugin`: `latency = 3`, a halt of three cycles. -/
  mulLatency : Nat := 3
  /-- `PostedStoreShim` buffer depth (`RiscqFiber(storeBufDepth = 4)`). -/
  storeDepth : Nat := 4
  /-- Data request to response on every slave of the core's data bus: request pipe, the slave's
      fixed latency, response pipe. Measured 5 on RAM, the control block, the put bridge and the
      host window. -/
  dataLatency : Nat := 5
  /-- An accepted store reaches the data bus two cycles later (the shim's FIFO). Measured. -/
  storeToBus : Nat := 2
  /-- A store on the data bus leaves the core on the posted link (`PutBridge`) or the host window
      this many cycles later. Measured 2. -/
  busToOut : Nat := 2
  deriving Inhabited, Repr

/-- An instruction in flight between the PC stage and register write. -/
structure PipeSlot where
  pc : UInt32
  /-- Fetch source id of its instruction word. -/
  id : Nat
  /-- The successor fetch chose (`Fetch.NEXT_PC_PRED`). -/
  predNext : UInt32
  /-- GShare hash computed at the PC stage (`HASH`). -/
  hash : Nat
  deriving Inhabited, BEq, Repr

/-- A predictor write that takes effect at the end of cycle `cyc`. -/
inductive Learn where
  | btb (cyc idx : Nat) (tag target : UInt32) (cond : Bool)
  | dir (cyc idx : Nat) (bit : Bool)
  | history (cyc : Nat) (taken : Bool)
  | counter (cyc hash value : Nat)
  deriving Inhabited, BEq, Repr

def Learn.cyc : Learn → Nat
  | .btb c .. | .dir c .. | .history c .. | .counter c .. => c

structure Pipe where
  pcReg : UInt32 := 0x80000000
  /-- `forkStream`'s `fired` flag for the PC now at stage 0. -/
  forkFired : Bool := false
  reserveId : Nat := 0
  /-- For each fetch id, the cycle its outstanding response arrives (`inflight` until the end of
      that cycle; the join may take it in that cycle by the same-cycle bypass). -/
  idArrive : Array (Option Nat) := Array.replicate 8 none
  /-- Stage registers 1..8 (index 0 unused: stage 0 is `pcReg`). Index 5 is the skid buffer's
      `StageLink` register; `s2m` is the `S2MLink` buffer behind it. -/
  stages : Array (Option PipeSlot) := Array.replicate 9 none
  s2m : Option PipeSlot := none
  /-- The instruction now at stage 8 mispredicted: redirect to this PC in this cycle. -/
  redirect : Option UInt32 := none
  /-- Cycle the instruction at execute entered it, and the cycle it may fire (`none` while its
      response depends on a halting read). -/
  exEnter : Option Nat := none
  exFire : Option Nat := none
  /-- For a store at execute: the cycle its data-bus write starts. -/
  exBus : Option Nat := none
  btbValid : Array Bool := Array.replicate 2 false
  btbTag : Array UInt32 := Array.replicate 2 0
  btbTarget : Array UInt32 := Array.replicate 2 0
  btbCond : Array Bool := Array.replicate 2 false
  btbDir : Array Bool := Array.replicate 2 false
  /-- GShare 2-bit counters, reset weakly taken (2). -/
  ctr : Array Nat := Array.replicate 64 2
  history : Nat := 0
  learns : Array Learn := #[]
  /-- Data-bus write starts of stores accepted by the shim (a store occupies the buffer until its
      start), and the first cycle the data bus is free for the next request. -/
  storeStarts : Array Nat := #[]
  busFree : Nat := 0
  deriving Inhabited, BEq, Repr

/-- Positional register fields, as `DecoderPlugin` takes them for every format. -/
def fieldRd (w : UInt32) : Nat := ((w >>> 7) &&& 31).toNat
def fieldRs1 (w : UInt32) : Nat := ((w >>> 15) &&& 31).toNat
def fieldRs2 (w : UInt32) : Nat := ((w >>> 20) &&& 31).toNat

/-- `Execute.RD_WRITE` of `WriteBackPlugin`: a load, a jump, an ALU op that writes rd, or a
    multiply. Branches, stores and fences write nothing. -/
def writesRd : Instr → Bool
  | .lui .. | .auipc .. | .jal .. | .jalr .. | .load .. | .opImm .. | .op .. | .mulOp .. => true
  | _ => false

namespace Pipe

def btbIndex (c : PipeConfig) (pc : UInt32) : Nat := ((pc >>> 2).toNat) % c.btbSets
def btbTagOf (c : PipeConfig) (pc : UInt32) : UInt32 := pc >>> (2 + Nat.log2 c.btbSets).toUInt32

/-- `BtbPlugin.read` at the PC stage: the predicted successor and whether it is a taken prediction. -/
def predict (c : PipeConfig) (p : Pipe) (pc : UInt32) : UInt32 × Bool :=
  let i := btbIndex c pc
  let hit := p.btbValid[i]! && p.btbTag[i]! == btbTagOf c pc
  let taken := hit && (!p.btbCond[i]! || p.btbDir[i]!)
  if taken then (p.btbTarget[i]!, true) else (pc + 4, false)

/-- `GSharePlugin.hashOf`: PC bits [2, 2 + w) xor the history. -/
def hashOf (c : PipeConfig) (p : Pipe) (pc : UInt32) : Nat :=
  (((pc >>> 2).toNat) % (2 ^ c.gshareWidth)) ^^^ p.history

/-- Apply the predictor writes that take effect at the end of cycle `t`. -/
def applyLearns (c : PipeConfig) (p : Pipe) (t : Nat) : Pipe := Id.run do
  let mut p := p
  let (now, later) := p.learns.partition (·.cyc ≤ t)
  for l in now do
    match l with
    | .btb _ i tag target cond =>
      p := { p with btbValid := p.btbValid.set! i true, btbTag := p.btbTag.set! i tag,
                    btbTarget := p.btbTarget.set! i target, btbCond := p.btbCond.set! i cond }
    | .dir _ i bit => p := { p with btbDir := p.btbDir.set! i bit }
    | .history _ taken =>
      p := { p with history := ((p.history <<< 1) ||| (if taken then 1 else 0)) % (2 ^ c.gshareWidth) }
    | .counter _ h v => p := { p with ctr := p.ctr.set! h v }
  return { p with learns := later }

/-- The learn of a branch or jump that leaves execute at cycle `e` (`BranchPlugin.learn`,
    registered one cycle; `BtbPlugin.learn`; `GSharePlugin.update`). `gdir` is the counter the
    synchronous read returns: its value before this cycle's writes. -/
def learn (c : PipeConfig) (p : Pipe) (e : Nat) (slot : PipeSlot) (taken : Bool) (target : UInt32) (cond : Bool) : Pipe :=
  let i := btbIndex c slot.pc
  let tag := btbTagOf c slot.pc
  let owns := p.btbValid[i]! && p.btbTag[i]! == tag
  let ctrNow := p.ctr[slot.hash]!
  let gdir := ctrNow ≥ 2
  let next := if taken then min 3 (ctrNow + 1) else ctrNow - 1
  let ls := #[] ++ (if taken then #[Learn.btb (e + 1) i tag target cond] else #[])
    ++ (if cond && (taken || owns) then #[Learn.dir (e + 1) i gdir] else #[])
    ++ (if cond then #[Learn.history (e + 1) taken, Learn.counter (e + 2) slot.hash next] else #[])
  { p with learns := p.learns ++ ls }

/-- Whether a fetch id still has its response outstanding at cycle `t`. -/
def busy (p : Pipe) (id t : Nat) : Bool :=
  match p.idArrive[id]! with
  | some a => a ≥ t
  | none => false

/-- The word of a slot is at the join by cycle `t` (stored, or arriving this cycle). -/
def arrived (p : Pipe) (s : PipeSlot) (t : Nat) : Bool :=
  match p.idArrive[s.id]! with
  | some a => a ≤ t
  | none => true

/-- Throw away the wrong-path instructions of stages 0–7 when the instruction at stage 8
    redirects at cycle `t` (`throwStagesBefore`, `throwSkidsBefore`, the head thrown with
    `usingReady = true`, so it counts as moving and may still issue its Get). -/
def flush (c : PipeConfig) (p : Pipe) (t : Nat) (target : UInt32) : Pipe := Id.run do
  let mut p := p
  if !p.forkFired && !busy p p.reserveId t then
    p := { p with idArrive := p.idArrive.set! p.reserveId (some (t + c.fetchLatency)) }
  p := { p with
    reserveId := (p.reserveId + 1) % c.fetchIds, forkFired := false, pcReg := target,
    stages := (Array.replicate 9 none), s2m := none, redirect := none,
    exEnter := none, exFire := none, exBus := none }
  return p

/-- What the execute stage does in a cycle. -/
inductive Exec where
  /-- No instruction at execute, or it is still halted. -/
  | idle
  /-- The instruction at execute leaves it this cycle. -/
  | fire

/-- Advance every stage but execute by one cycle `t`. `fired`: the instruction at execute leaves
    it this cycle (so stage 7 is free for stage 6). `mem` gives the instruction word at a PC. -/
def advance (c : PipeConfig) (p : Pipe) (t : Nat) (fired : Bool) (word : UInt32 → UInt32) : Pipe := Id.run do
  let st := p.stages
  -- Stage 8 never back-pressures. Stage 7 moves to 8 when it fires (the caller moves it).
  let free7 := st[7]!.isNone || fired
  -- Interlock at register read: the instruction at execute (valid this cycle, fired or not)
  -- writes rd ≠ 0 that the instruction at stage 6 names as rs1 or rs2 (`aluNoFastForward`).
  let blocked := match st[7]!, st[6]! with
    | some prod, some cons =>
      let pw := word prod.pc
      let cw := word cons.pc
      let rd := fieldRd pw
      writesRd (decode pw true) && rd != 0 && (fieldRs1 cw == rd || fieldRs2 cw == rd)
    | _, _ => false
  let move6 := st[6]!.isSome && free7 && !blocked
  let free6 := st[6]!.isNone || move6
  -- Stage 5 output (`S2MLink`): the buffer if it holds one, else the skid register.
  let out5 := if p.s2m.isSome then p.s2m else st[5]!
  let move5 := out5.isSome && free6
  -- The skid register passes on (to stage 6 or into the buffer) whenever the buffer is empty.
  let skidPasses := p.s2m.isNone
  let skidFree := st[5]!.isNone || skidPasses
  -- Join: stage 4 needs its word.
  let move4 := match st[4]! with
    | some s => skidFree && arrived p s t
    | none => false
  let free4 := st[4]!.isNone || move4
  let move3 := st[3]!.isSome && free4
  let free3 := st[3]!.isNone || move3
  let move2 := st[2]!.isSome && free3
  let free2 := st[2]!.isNone || move2
  let move1 := st[1]!.isSome && free2
  let free1 := st[1]!.isNone || move1
  -- Stage 0: the fork issues its Get once; the node waits for it, then moves when stage 1 is free.
  let full := busy p p.reserveId t
  let issueNow := !p.forkFired && !full
  let forked := p.forkFired || issueNow
  let move0 := forked && free1
  let (predNext, _) := predict c p p.pcReg
  let headSlot : PipeSlot := { pc := p.pcReg, id := p.reserveId, predNext, hash := hashOf c p p.pcReg }
  -- New contents.
  let mut ns := Array.replicate 9 (none : Option PipeSlot)
  ns := ns.set! 8 (if fired then st[7]! else none)
  ns := ns.set! 7 (if move6 then st[6]! else if fired then none else st[7]!)
  ns := ns.set! 6 (if move5 then out5 else if move6 then none else st[6]!)
  -- S2M buffer and skid register.
  let mut s2m := p.s2m
  let mut skid := st[5]!
  if p.s2m.isSome then
    if move5 then s2m := none
  else if st[5]!.isSome then
    if move5 then skid := none
    else
      s2m := st[5]!
      skid := none
  ns := ns.set! 5 (if move4 then st[4]! else skid)
  ns := ns.set! 4 (if move3 then st[3]! else if move4 then none else st[4]!)
  ns := ns.set! 3 (if move2 then st[2]! else if move3 then none else st[3]!)
  ns := ns.set! 2 (if move1 then st[1]! else if move2 then none else st[2]!)
  ns := ns.set! 1 (if move0 then some headSlot else if move1 then none else st[1]!)
  let mut idArrive := p.idArrive
  if issueNow then idArrive := idArrive.set! p.reserveId (some (t + c.fetchLatency))
  let p := { p with
    stages := ns, s2m, idArrive,
    forkFired := if move0 then false else forked,
    reserveId := if move0 then (p.reserveId + 1) % c.fetchIds else p.reserveId,
    pcReg := if move0 then predNext else p.pcReg }
  return p

/-- The data-bus timing of a store that reaches execute at cycle `e`: the cycle the shim accepts
    it (it fires one cycle later), the cycle its write starts on the data bus, and the new pipe.
    The shim holds `storeDepth` stores that have not yet started; a store finding it full is
    accepted the cycle after the oldest one starts. Writes start one at a time, each after the
    previous request's response (`PostedStoreShim`: one downstream transaction in flight). -/
def acceptStore (c : PipeConfig) (p : Pipe) (e : Nat) : Nat × Nat × Pipe :=
  let pending := (p.storeStarts.filter (· ≥ e)).qsort (· < ·)
  let accept := if pending.size < c.storeDepth then e else pending[pending.size - c.storeDepth]! + 1
  let start := max (accept + c.storeToBus) p.busFree
  (accept, start, { p with storeStarts := (p.storeStarts.filter (· ≥ accept)).push start,
                            busFree := start + c.dataLatency + 1 })

/-- The data-bus timing of a load reaching execute at cycle `e`: it waits until every accepted
    store has finished (the shim forwards a read only with its buffer empty and nothing in
    flight), then its response comes `dataLatency` later. Returns the request and response cycles. -/
def startLoad (c : PipeConfig) (p : Pipe) (e : Nat) : Nat × Nat × Pipe :=
  let start := max e p.busFree
  (start, start + c.dataLatency, { p with busFree := start + c.dataLatency + 1 })

end Pipe
end QControl.RiscQ
