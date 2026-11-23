// Inclusive hardware-counter deadline, in integer PL clock cycles from FIFO start.
export function deadlineCounts(group, budget) {
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw Error("Enter a nonnegative whole number of clock cycles.");
  const measured = group.counterCycles;
  const latest = Math.max(...measured);
  return {
    missed: measured.filter((c) => c > budget).length,
    count: measured.length,
    replayMet: group.predictedCycles <= budget,
    latestCycles: latest,
    largestLateCycles: Math.max(0, latest - budget),
  };
}
