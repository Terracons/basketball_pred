// Count models keep probability on nonnegative integers, including exact pushes.
export function countLineProbabilities(mean, variance, line) {
  if (![mean, variance, line].every(Number.isFinite) || mean < 0 || mean > 500 || variance < 0 || line < 0 || line > 1000) throw new Error('Invalid count distribution');
  if (mean === 0) return { under: line > 0 ? 1 : 0, over: 0, push: line === 0 ? 1 : 0 };
  const size = variance > mean ? mean * mean / (variance - mean) : Infinity;
  const poisson = size > 1e6, p = poisson ? 1 : size / (size + mean);
  let mass = poisson ? Math.exp(-mean) : Math.exp(size * Math.log(p)), under = 0, push = 0;
  for (let k = 0; k <= Math.floor(line); k++) {
    if (k < line) under += mass; else push = mass;
    mass *= poisson ? mean / (k + 1) : (k + size) / (k + 1) * (1 - p);
  }
  under = Math.max(0, Math.min(1, under)); push = Math.max(0, Math.min(1 - under, push));
  return { under, over: Math.max(0, 1 - under - push), push };
}
