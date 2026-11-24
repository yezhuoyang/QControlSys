/-! RV32I with the multiply-only Zmmul subset, as executed by one RISC-Q control core.

    RISC-Q gives each qubit an in-order RV32I core that issues timed register writes.
    This file is the architectural semantics of that core: decode a 32-bit word, then
    compute the register update and the single bus access it requests. Bus accesses are
    resolved by `QControl.RiscQ.Soc`, where RAM, the control block and the posted link live.

    Units: registers and addresses are 32-bit words. Shift amounts use the low five bits.
    Boundary: no CSRs, interrupts, compressed or atomic instructions. An unsupported word
    decodes to `illegal` and stops the core with a fault frame.
    Evidence: RISC-Q `docs/riscv/RISCV.md` (RV32I, optional Zmmul, single issue, in order). -/
namespace QControl.RiscQ

inductive BrOp where | beq | bne | blt | bge | bltu | bgeu
  deriving Repr, DecidableEq, Inhabited

inductive LdOp where | lb | lh | lw | lbu | lhu
  deriving Repr, DecidableEq, Inhabited

inductive StOp where | sb | sh | sw
  deriving Repr, DecidableEq, Inhabited

inductive AluOp where | add | sub | sll | slt | sltu | xor | srl | sra | or | and
  deriving Repr, DecidableEq, Inhabited

inductive MulOp where | mul | mulh | mulhsu | mulhu
  deriving Repr, DecidableEq, Inhabited

/-- Decoded instruction. Immediates are already sign-extended to 32 bits. -/
inductive Instr where
  | lui (rd : Nat) (imm : UInt32)
  | auipc (rd : Nat) (imm : UInt32)
  | jal (rd : Nat) (offset : UInt32)
  | jalr (rd rs1 : Nat) (imm : UInt32)
  | branch (op : BrOp) (rs1 rs2 : Nat) (offset : UInt32)
  | load (op : LdOp) (rd rs1 : Nat) (imm : UInt32)
  | store (op : StOp) (rs1 rs2 : Nat) (imm : UInt32)
  | opImm (op : AluOp) (rd rs1 : Nat) (imm : UInt32)
  | op (op : AluOp) (rd rs1 rs2 : Nat)
  | mulOp (op : MulOp) (rd rs1 rs2 : Nat)
  | fence
  | ecall
  | ebreak
  | illegal (word : UInt32)
  deriving Repr, Inhabited

/-- Bits `[lo, lo + width)` of a word, right aligned. -/
def bits (w : UInt32) (lo width : Nat) : UInt32 :=
  (w >>> lo.toUInt32) &&& ((1 <<< width.toUInt32) - 1)

/-- Sign-extend the low `width` bits (1 ≤ width ≤ 31). -/
def signExtend (w : UInt32) (width : Nat) : UInt32 :=
  let low := w &&& ((1 <<< width.toUInt32) - 1)
  if low &&& (1 <<< (width - 1).toUInt32) != 0 then low ||| (0xFFFFFFFF <<< width.toUInt32) else low

def immI (w : UInt32) : UInt32 := signExtend (bits w 20 12) 12
def immS (w : UInt32) : UInt32 := signExtend ((bits w 25 7 <<< 5) ||| bits w 7 5) 12
def immB (w : UInt32) : UInt32 :=
  signExtend ((bits w 31 1 <<< 12) ||| (bits w 7 1 <<< 11) ||| (bits w 25 6 <<< 5) ||| (bits w 8 4 <<< 1)) 13
def immU (w : UInt32) : UInt32 := w &&& 0xFFFFF000
def immJ (w : UInt32) : UInt32 :=
  signExtend ((bits w 31 1 <<< 20) ||| (bits w 12 8 <<< 12) ||| (bits w 20 1 <<< 11) ||| (bits w 21 10 <<< 1)) 21

def decode (w : UInt32) (withMul : Bool := true) : Instr :=
  let rd := (bits w 7 5).toNat
  let rs1 := (bits w 15 5).toNat
  let rs2 := (bits w 20 5).toNat
  let f3 := (bits w 12 3).toNat
  let f7 := (bits w 25 7).toNat
  match (bits w 0 7).toNat with
  | 0x37 => .lui rd (immU w)
  | 0x17 => .auipc rd (immU w)
  | 0x6F => .jal rd (immJ w)
  | 0x67 => if f3 == 0 then .jalr rd rs1 (immI w) else .illegal w
  | 0x63 =>
    match f3 with
    | 0 => .branch .beq rs1 rs2 (immB w) | 1 => .branch .bne rs1 rs2 (immB w)
    | 4 => .branch .blt rs1 rs2 (immB w) | 5 => .branch .bge rs1 rs2 (immB w)
    | 6 => .branch .bltu rs1 rs2 (immB w) | 7 => .branch .bgeu rs1 rs2 (immB w)
    | _ => .illegal w
  | 0x03 =>
    match f3 with
    | 0 => .load .lb rd rs1 (immI w) | 1 => .load .lh rd rs1 (immI w) | 2 => .load .lw rd rs1 (immI w)
    | 4 => .load .lbu rd rs1 (immI w) | 5 => .load .lhu rd rs1 (immI w)
    | _ => .illegal w
  | 0x23 =>
    match f3 with
    | 0 => .store .sb rs1 rs2 (immS w) | 1 => .store .sh rs1 rs2 (immS w) | 2 => .store .sw rs1 rs2 (immS w)
    | _ => .illegal w
  | 0x13 =>
    match f3 with
    | 0 => .opImm .add rd rs1 (immI w) | 2 => .opImm .slt rd rs1 (immI w) | 3 => .opImm .sltu rd rs1 (immI w)
    | 4 => .opImm .xor rd rs1 (immI w) | 6 => .opImm .or rd rs1 (immI w) | 7 => .opImm .and rd rs1 (immI w)
    | 1 => if f7 == 0 then .opImm .sll rd rs1 (bits w 20 5) else .illegal w
    | 5 => if f7 == 0 then .opImm .srl rd rs1 (bits w 20 5)
           else if f7 == 0x20 then .opImm .sra rd rs1 (bits w 20 5) else .illegal w
    | _ => .illegal w
  | 0x33 =>
    if f7 == 0 then
      match f3 with
      | 0 => .op .add rd rs1 rs2 | 1 => .op .sll rd rs1 rs2 | 2 => .op .slt rd rs1 rs2
      | 3 => .op .sltu rd rs1 rs2 | 4 => .op .xor rd rs1 rs2 | 5 => .op .srl rd rs1 rs2
      | 6 => .op .or rd rs1 rs2 | _ => .op .and rd rs1 rs2
    else if f7 == 0x20 then
      match f3 with
      | 0 => .op .sub rd rs1 rs2 | 5 => .op .sra rd rs1 rs2 | _ => .illegal w
    else if f7 == 1 && withMul then
      match f3 with
      | 0 => .mulOp .mul rd rs1 rs2 | 1 => .mulOp .mulh rd rs1 rs2
      | 2 => .mulOp .mulhsu rd rs1 rs2 | 3 => .mulOp .mulhu rd rs1 rs2
      | _ => .illegal w
    else .illegal w
  | 0x0F => .fence
  | 0x73 => if w == 0x00000073 then .ecall else if w == 0x00100073 then .ebreak else .illegal w
  | _ => .illegal w

/-- Two's-complement value of a word. -/
def toSigned (w : UInt32) : Int := if w ≥ 0x80000000 then (w.toNat : Int) - 4294967296 else w.toNat

def ofInt (i : Int) : UInt32 := (i.emod 4294967296).toNat.toUInt32

def slt (a b : UInt32) : Bool := (a ^^^ 0x80000000) < (b ^^^ 0x80000000)

def sra (a sh : UInt32) : UInt32 :=
  let n := sh &&& 31
  if a ≥ 0x80000000 then (a >>> n) ||| ~~~(0xFFFFFFFF >>> n) else a >>> n

def alu (op : AluOp) (a b : UInt32) : UInt32 :=
  match op with
  | .add => a + b | .sub => a - b
  | .sll => a <<< (b &&& 31) | .srl => a >>> (b &&& 31) | .sra => sra a b
  | .slt => if slt a b then 1 else 0 | .sltu => if a < b then 1 else 0
  | .xor => a ^^^ b | .or => a ||| b | .and => a &&& b

def mulAlu (op : MulOp) (a b : UInt32) : UInt32 :=
  match op with
  | .mul => a * b
  | .mulh => ofInt ((toSigned a * toSigned b).ediv 4294967296)
  | .mulhsu => ofInt ((toSigned a * (b.toNat : Int)).ediv 4294967296)
  | .mulhu => ((a.toNat * b.toNat) / 4294967296).toUInt32

def taken (op : BrOp) (a b : UInt32) : Bool :=
  match op with
  | .beq => a == b | .bne => a != b
  | .blt => slt a b | .bge => !slt a b
  | .bltu => a < b | .bgeu => !(a < b)

/-- Architectural state of one core. `regs` holds x0…x31. x0 is never written. -/
structure Cpu where
  pc : UInt32
  regs : Array UInt32

def Cpu.reg (c : Cpu) (i : Nat) : UInt32 := if i == 0 then 0 else c.regs[i]?.getD 0

def Cpu.setReg (c : Cpu) (i : Nat) (v : UInt32) : Cpu :=
  if i == 0 || i ≥ c.regs.size then c else { c with regs := c.regs.set! i v }

theorem Cpu.reg_zero (c : Cpu) : c.reg 0 = 0 := by simp [Cpu.reg]

/-- Writing x0 leaves the register file unchanged. -/
theorem Cpu.setReg_zero (c : Cpu) (v : UInt32) : c.setReg 0 v = c := by simp [Cpu.setReg]

/-- The bus access an instruction requests after its register-only part has been applied. -/
inductive Access where
  | none
  | load (op : LdOp) (rd : Nat) (address : UInt32)
  | store (op : StOp) (address value : UInt32)
  | stop (reason : String)
  deriving Repr, Inhabited

structure Step where
  cpu : Cpu
  access : Access
  /-- The program counter left the fall-through path. The timing model charges a refill. -/
  redirect : Bool

/-- Execute one decoded instruction up to its bus access. A load leaves `rd` for the bus. -/
def exec (c : Cpu) (i : Instr) : Step :=
  let next := c.pc + 4
  match i with
  | .lui rd imm => ⟨{ c.setReg rd imm with pc := next }, .none, false⟩
  | .auipc rd imm => ⟨{ c.setReg rd (c.pc + imm) with pc := next }, .none, false⟩
  | .jal rd offset => ⟨{ c.setReg rd next with pc := c.pc + offset }, .none, true⟩
  | .jalr rd rs1 imm =>
    let target := (c.reg rs1 + imm) &&& 0xFFFFFFFE
    ⟨{ c.setReg rd next with pc := target }, .none, true⟩
  | .branch o rs1 rs2 offset =>
    if taken o (c.reg rs1) (c.reg rs2) then ⟨{ c with pc := c.pc + offset }, .none, true⟩
    else ⟨{ c with pc := next }, .none, false⟩
  | .load o rd rs1 imm => ⟨{ c with pc := next }, .load o rd (c.reg rs1 + imm), false⟩
  | .store o rs1 rs2 imm => ⟨{ c with pc := next }, .store o (c.reg rs1 + imm) (c.reg rs2), false⟩
  | .opImm o rd rs1 imm => ⟨{ c.setReg rd (alu o (c.reg rs1) imm) with pc := next }, .none, false⟩
  | .op o rd rs1 rs2 => ⟨{ c.setReg rd (alu o (c.reg rs1) (c.reg rs2)) with pc := next }, .none, false⟩
  | .mulOp o rd rs1 rs2 => ⟨{ c.setReg rd (mulAlu o (c.reg rs1) (c.reg rs2)) with pc := next }, .none, false⟩
  | .fence => ⟨{ c with pc := next }, .none, false⟩
  | .ecall => ⟨c, .stop "ecall", false⟩
  | .ebreak => ⟨c, .stop "ebreak", false⟩
  | .illegal w => ⟨c, .stop s!"illegal instruction 0x{String.ofList (Nat.toDigits 16 w.toNat)}", false⟩

/-- A jump to its own address changes nothing. Firmware uses it to park. -/
def Instr.isSelfJump : Instr → Bool
  | .jal _ offset => offset == 0
  | _ => false

/-- A self jump is a fixed point of the program counter. -/
theorem exec_selfJump_pc (c : Cpu) (rd : Nat) : (exec c (.jal rd 0)).cpu.pc = c.pc := by
  simp [exec]

private def regName (i : Nat) : String := s!"x{i}"

private def hex (w : UInt32) : String := "0x" ++ String.ofList (Nat.toDigits 16 w.toNat)

private def dec (w : UInt32) : String := toString (toSigned w)

/-- Assembly text for the debugger. -/
def Instr.text : Instr → String
  | .lui rd imm => s!"lui {regName rd}, {hex (imm >>> 12)}"
  | .auipc rd imm => s!"auipc {regName rd}, {hex (imm >>> 12)}"
  | .jal rd offset => s!"jal {regName rd}, {dec offset}"
  | .jalr rd rs1 imm => s!"jalr {regName rd}, {dec imm}({regName rs1})"
  | .branch o rs1 rs2 offset =>
    let n := match o with
      | .beq => "beq" | .bne => "bne" | .blt => "blt" | .bge => "bge" | .bltu => "bltu" | .bgeu => "bgeu"
    s!"{n} {regName rs1}, {regName rs2}, {dec offset}"
  | .load o rd rs1 imm =>
    let n := match o with | .lb => "lb" | .lh => "lh" | .lw => "lw" | .lbu => "lbu" | .lhu => "lhu"
    s!"{n} {regName rd}, {dec imm}({regName rs1})"
  | .store o rs1 rs2 imm =>
    let n := match o with | .sb => "sb" | .sh => "sh" | .sw => "sw"
    s!"{n} {regName rs2}, {dec imm}({regName rs1})"
  | .opImm o rd rs1 imm =>
    let n := match o with
      | .add => "addi" | .sub => "subi" | .sll => "slli" | .slt => "slti" | .sltu => "sltiu"
      | .xor => "xori" | .srl => "srli" | .sra => "srai" | .or => "ori" | .and => "andi"
    s!"{n} {regName rd}, {regName rs1}, {dec imm}"
  | .op o rd rs1 rs2 =>
    let n := match o with
      | .add => "add" | .sub => "sub" | .sll => "sll" | .slt => "slt" | .sltu => "sltu"
      | .xor => "xor" | .srl => "srl" | .sra => "sra" | .or => "or" | .and => "and"
    s!"{n} {regName rd}, {regName rs1}, {regName rs2}"
  | .mulOp o rd rs1 rs2 =>
    let n := match o with | .mul => "mul" | .mulh => "mulh" | .mulhsu => "mulhsu" | .mulhu => "mulhu"
    s!"{n} {regName rd}, {regName rs1}, {regName rs2}"
  | .fence => "fence"
  | .ecall => "ecall"
  | .ebreak => "ebreak"
  | .illegal w => s!".word {hex w}"

end QControl.RiscQ
