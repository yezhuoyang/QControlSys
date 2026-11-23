import Lean
import Init.Data.Rat.Lemmas

/-! Independent scoring of held-out verification witnesses. Every finite JSON decimal
    is read as an exact rational. The comparison uses squared quantities, so a
    result exactly on a registered threshold passes without taking a square root. -/
namespace QControl.Validation
open Lean

inductive Rule where
  | absolute (maxRmse : Rat)
  | normalized (maxNrmse minR2 : Rat)
  deriving DecidableEq

/-- Registered criteria. A supplied rule must agree with the benchmark identifier. -/
def registered : String → Option Rule
  | "qccd" => some (.absolute 12)
  | "qccd-h2" => some (.absolute (15 / 100))
  | "qccd-slow" => some (.absolute (1 / 10))
  | "qccd-pair" => some (.absolute 10)
  | "neutral" => some (.absolute (1 / 4))
  | "superconducting" => some (.normalized (15 / 100) (75 / 100))
  | _ => none

private def numeric (j : Json) : Except String Rat := do
  let n ← j.getNum?
  unless n.exponent ≤ 1024 && n.mantissa.natAbs < 10 ^ 1024 do
    throw "A numeric field exceeds the supported 1024 decimal digits or places."
  return (n.mantissa : Rat) / ((10 ^ n.exponent : Nat) : Rat)

private def objectSize (j : Json) (size : Nat) : Except String Unit := do
  unless (← j.getObj?).size == size do throw "Unexpected or missing witness field."

private def readRule (j : Json) : Except String Rule := do
  match ← (← j.getObjVal? "kind").getStr? with
  | "absolute" =>
    objectSize j 2
    return .absolute (← numeric (← j.getObjVal? "maxRmse"))
  | "normalized" =>
    objectSize j 3
    return .normalized (← numeric (← j.getObjVal? "maxNrmse"))
                       (← numeric (← j.getObjVal? "minR2"))
  | _ => throw "Unknown held-out scoring rule."

/-- Divide by a positive count on the mathematical side and clear it on the
    executable side. For RMSE, threshold is the squared tolerance. -/
theorem clear_positive_denominator (sse count threshold : Rat) (positive : 0 < count) :
    sse / count ≤ threshold ↔ sse ≤ threshold * count := by
  calc
    sse / count ≤ threshold ↔ ¬ threshold < sse / count := Rat.not_lt.symm
    _ ↔ ¬ threshold * count < sse := not_congr (Rat.lt_div_iff positive)
    _ ↔ sse ≤ threshold * count := Rat.not_lt

def within (sse count limit : Rat) : Bool := decide (sse ≤ (limit * limit) * count)

theorem within_iff_mean_squared (sse count limit : Rat) (positive : 0 < count) :
    within sse count limit = true ↔ sse / count ≤ limit * limit := by
  simp only [within, decide_eq_true_eq]
  exact (clear_positive_denominator sse count (limit * limit) positive).symm

/-- With nonzero observed variance, the executable bound on unexplained variation
    agrees with the usual lower bound on the coefficient of determination. -/
theorem r2_bound_iff (sse sst minimum : Rat) (positive : 0 < sst) :
    minimum ≤ 1 - sse / sst ↔ sse ≤ (1 - minimum) * sst := by
  calc
    minimum ≤ 1 - sse / sst ↔ minimum + sse / sst ≤ 1 := Rat.le_sub_iff
    _ ↔ sse / sst + minimum ≤ 1 := by rw [Rat.add_comm minimum]
    _ ↔ sse / sst ≤ 1 - minimum := Rat.le_sub_iff.symm
    _ ↔ sse ≤ (1 - minimum) * sst := clear_positive_denominator _ _ _ positive

private def fraction (r : Rat) : Json := Json.mkObj [
  ("numerator", toJson (toString r.num)), ("denominator", toJson (toString r.den))]

/-- Accumulate on held-out observations only. SSE and the variance use exact arithmetic. -/
def check (j : Json) : Except String Json := do
  objectSize j 4
  unless (← (← j.getObjVal? "version").getNat?) == 1 do throw "Unknown witness version."
  let platform ← (← j.getObjVal? "platform").getStr?
  let some expected := registered platform | throw "Unregistered physical benchmark."
  let rule ← readRule (← j.getObjVal? "rule")
  unless decide (rule = expected) do throw "Witness rule differs from the registered criterion."
  let rows ← (← j.getObjVal? "rows").getArr?
  unless rows.size ≤ 100000 do throw "Too many witness observations."
  let mut seen : Std.HashSet String := {}
  let mut calibration := 0
  let mut held := 0
  let mut sse : Rat := 0
  let mut total : Rat := 0
  let mut sumSquares : Rat := 0
  let mut bottom : Rat := 0
  let mut top : Rat := 0
  for row in rows do
    objectSize row 4
    let id ← (← row.getObjVal? "id").getStr?
    unless !id.trimAscii.isEmpty && !seen.contains id do throw "Empty or duplicate observation ID."
    seen := seen.insert id
    let observed ← numeric (← row.getObjVal? "observed")
    let predicted ← numeric (← row.getObjVal? "predicted")
    match ← (← row.getObjVal? "split").getStr? with
    | "calibration" => calibration := calibration + 1
    | "holdout" =>
      bottom := if held == 0 then observed else min bottom observed
      top := if held == 0 then observed else max top observed
      held := held + 1
      total := total + observed
      sumSquares := sumSquares + observed * observed
      let residual := predicted - observed
      sse := sse + residual * residual
    | _ => throw "The split must be calibration or holdout."
  unless calibration > 0 && held > 0 do throw "Both calibration and holdout must be nonempty."
  let n := (held : Rat)
  let mse := sse / n
  let common := [("evaluated", toJson true), ("platform", toJson platform),
    ("calibrationCount", toJson calibration), ("holdoutCount", toJson held),
    ("sumSquaredError", fraction sse), ("meanSquaredError", fraction mse)]
  match rule with
  | .absolute limit =>
    return Json.mkObj (common ++ [("passed", toJson (within sse n limit))])
  | .normalized limit minR2 =>
    let span := top - bottom
    let sst := sumSquares - total * total / n
    unless 0 < span && 0 < sst do throw "Range and total sum of squares must be positive."
    let okError := within sse n (span * limit)
    let r2 := 1 - sse / sst
    let okR2 := decide (sse ≤ (1 - minR2) * sst)
    return Json.mkObj (common ++ [("passed", toJson (okError && okR2)),
      ("withinNormalizedRmse", toJson okError), ("withinR2", toJson okR2),
      ("range", fraction span), ("totalSumOfSquares", fraction sst),
      ("normalizedMeanSquaredError", fraction (mse / (span * span))), ("r2", fraction r2)])

end QControl.Validation
