/-!
A binary min-heap on an array, ordered by a strict comparison `lt`. The simulator's event agenda and
its ready cores are heaps: with many cores and many pending events, a sorted list and a scan of every
core cost a pass over all of them per step. The order is the comparison's, so a heap keyed by
(cycle, insertion number) pops events in the order the sorted list held them, and one keyed by
(ready cycle, core index) picks the core the scan picked.
-/
namespace QControl.RiscQ

structure Heap (α : Type) where
  data : Array α := #[]

namespace Heap
variable {α : Type}

def size (h : Heap α) : Nat := h.data.size
def top? (h : Heap α) : Option α := h.data[0]?

private def swapAt (a : Array α) (i j : Nat) : Array α :=
  match a[i]?, a[j]? with
  | some x, some y => (a.set! i y).set! j x
  | _, _ => a

/-- Add an element. -/
def push (lt : α → α → Bool) (h : Heap α) (x : α) : Heap α := Id.run do
  let mut a := h.data.push x
  let mut i := a.size - 1
  -- A path to the root is at most 64 levels long for any array that fits in memory.
  for _ in [0:64] do
    if i == 0 then break
    let parent := (i - 1) / 2
    match a[i]?, a[parent]? with
    | some x, some y =>
      if lt x y then
        a := swapAt a i parent
        i := parent
      else break
    | _, _ => break
  return ⟨a⟩

/-- Remove the least element. -/
def pop (lt : α → α → Bool) (h : Heap α) : Heap α := Id.run do
  if h.data.size ≤ 1 then return ⟨#[]⟩
  let some last := h.data.back? | return ⟨#[]⟩
  let mut a := h.data.pop.set! 0 last
  let n := a.size
  let mut i := 0
  for _ in [0:64] do
    let l := 2 * i + 1
    let r := l + 1
    let mut m := i
    if l < n then
      match a[l]?, a[m]? with
      | some x, some y => if lt x y then m := l
      | _, _ => pure ()
    if r < n then
      match a[r]?, a[m]? with
      | some x, some y => if lt x y then m := r
      | _, _ => pure ()
    if m == i then break
    a := swapAt a i m
    i := m
  return ⟨a⟩

end Heap
end QControl.RiscQ
