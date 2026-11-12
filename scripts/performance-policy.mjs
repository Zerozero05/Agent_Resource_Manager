// Acceptance policy is written before collecting native measurements. These are
// not machine benchmark results and must never be replaced by task timings.
export const PERFORMANCE_POLICY = Object.freeze({
  startupSamples: 10,
  localSamplesPerCategory: 100,
  localP95LimitMs: 200,
  // User permits limited small delays; keep the original target/status intact.
  limitedToleranceP95Ms: 500,
  limitedToleranceSlowInputFraction: .05,
  limitedToleranceMaximumExclusiveMs: 1000,
  stabilityDurationMs: 30 * 60 * 1000,
  sampleIntervalMs: 30 * 1000,
  warmupCycles: 5,
  idleCalibrationSamples: 11,
  tailSamples: 20,
  contentCacheLimitBytes: 64 * 1024 * 1024,
  minimumTailRangeBytes: 32 * 1024 * 1024,
  minimumMedianGrowthBytes: 16 * 1024 * 1024,
  minimumSlopeBytesPerMinute: 512 * 1024,
  idleCpuFloorPercent: 2,
});

export function percentile(values, p) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

export function ownedForeground(identity, expected) {
  return Boolean(identity && expected
    && Number.isSafeInteger(expected.pid) && expected.pid > 0
    && Number.isSafeInteger(expected.windowHandle) && expected.windowHandle > 0
    && identity.capturedHandle === expected.windowHandle
    && identity.currentMainHandle === expected.windowHandle
    && identity.uiaProcessId === expected.pid
    && identity.foregroundHandle === expected.windowHandle);
}

export function startupComparison(baseline, candidate) {
  if (baseline.length < PERFORMANCE_POLICY.startupSamples || candidate.length < PERFORMANCE_POLICY.startupSamples) return { status: 'incomplete', reason: 'Each native startup condition requires at least ten measurements.' };
  const baselineMedianMs = percentile(baseline, .5), candidateMedianMs = percentile(candidate, .5);
  if (baselineMedianMs === null || candidateMedianMs === null) return { status: 'invalid', reason: 'Invalid startup duration.' };
  const allowedIncrementMs = Math.max(baselineMedianMs * .1, 100);
  return { status: candidateMedianMs <= baselineMedianMs + allowedIncrementMs ? 'passed' : 'failed', baselineMedianMs, candidateMedianMs, allowedIncrementMs, actualIncrementMs: candidateMedianMs - baselineMedianMs };
}

function inputCondition(value) {
  if (!['native-ui-input-to-painted-result', 'native-accessibility-input-to-painted-result'].includes(value)) throw new Error('Unsupported native input measurement');
  return value;
}

function limitedInteractionTolerance(values) {
  const count = values.length;
  const invalidDurations = values.filter(value => !Number.isFinite(value) || value < 0).length;
  const enoughSamples = count >= PERFORMANCE_POLICY.localSamplesPerCategory;
  const p95Ms = enoughSamples ? percentile(values, .95) : null;
  const maximumObservedMs = count && !invalidDurations ? Math.max(...values) : null;
  const aboveTargetInputs = values.filter(value => value > PERFORMANCE_POLICY.localP95LimitMs).length;
  const aboveToleranceInputs = values.filter(value => value > PERFORMANCE_POLICY.limitedToleranceP95Ms).length;
  const aboveTargetFraction = count && !invalidDurations ? aboveTargetInputs / count : null;
  const aboveToleranceFraction = count && !invalidDurations ? aboveToleranceInputs / count : null;
  let status = 'incomplete';
  if (invalidDurations) status = 'invalid';
  else if (maximumObservedMs >= PERFORMANCE_POLICY.limitedToleranceMaximumExclusiveMs) status = 'failed';
  else if (enoughSamples) status = p95Ms <= PERFORMANCE_POLICY.limitedToleranceP95Ms && aboveToleranceFraction <= PERFORMANCE_POLICY.limitedToleranceSlowInputFraction ? 'passed' : 'failed';
  return { status, count, minimumSamples: PERFORMANCE_POLICY.localSamplesPerCategory, p95Ms, maximumObservedMs, aboveTargetInputs, aboveTargetFraction, aboveToleranceInputs, aboveToleranceFraction, invalidDurations, p95LimitMs: PERFORMANCE_POLICY.limitedToleranceP95Ms, slowInputFractionLimit: PERFORMANCE_POLICY.limitedToleranceSlowInputFraction, maximumExclusiveMs: PERFORMANCE_POLICY.limitedToleranceMaximumExclusiveMs };
}

export function localInteractionVerdict(samples, condition = 'native-ui-input-to-painted-result') {
  inputCondition(condition);
  return Object.fromEntries(['search', 'filter', 'tab', 'document'].map(category => {
    const values = samples.filter(sample => sample.category === category && sample.condition === condition).map(sample => sample.durationMs);
    const p95Ms = percentile(values, .95);
    return [category, { count: values.length, p95Ms, limitMs: PERFORMANCE_POLICY.localP95LimitMs, status: values.length < PERFORMANCE_POLICY.localSamplesPerCategory ? 'incomplete' : p95Ms === null ? 'invalid' : p95Ms <= PERFORMANCE_POLICY.localP95LimitMs ? 'passed' : 'failed', limitedTolerance: limitedInteractionTolerance(values) }];
  }));
}

// Additional native smoke coverage is intentionally separate from the >=100
// category/P95 gate. A task must actually overlap the input, never merely have
// completed earlier. The normal UI must cover all four categories for each load.
export function backgroundLoadVerdict(records, nativePid, condition = 'native-ui-input-to-painted-result') {
  inputCondition(condition);
  const expected = { check: 'check_now', download: 'apply_resource_download', update: 'apply_resource_update_stage' };
  return Object.fromEntries(Object.entries(expected).map(([kind, action]) => {
    const accepted = records.filter(record => record.kind === kind && record.taskAction === action && ['queued', 'running'].includes(record.beforeStatus) && record.sample?.pid === nativePid && record.sample.condition === condition && record.beforeObservedAtMs <= record.sample.startedAtUtcMs && record.afterObservedAtMs >= record.sample.finishedAtUtcMs && (['queued', 'running'].includes(record.afterStatus) || Date.parse(record.taskFinishedAt || '') >= record.sample.startedAtUtcMs));
    const categories = ['search', 'filter', 'tab', 'document'].map(category => ({ category, count: accepted.filter(record => record.sample.category === category).length }));
    const durations = accepted.map(record => record.sample.durationMs);
    const invalidDurations = durations.filter(value => !Number.isFinite(value) || value < 0).length;
    const overLimitInputs = durations.filter(value => value > PERFORMANCE_POLICY.localP95LimitMs).length;
    let status = categories.every(value => value.count > 0) ? 'passed' : 'incomplete';
    if (overLimitInputs) status = 'failed';
    if (invalidDurations) status = 'invalid';
    // Smoke coverage does not establish a per-category P95 or timeout rate.
    const toleranceCategories = Object.fromEntries(categories.map(({ category }) => [category, limitedInteractionTolerance(accepted.filter(record => record.sample.category === category).map(record => record.sample.durationMs))]));
    const toleranceStatuses = Object.values(toleranceCategories).map(value => value.status);
    const toleranceStatus = toleranceStatuses.includes('invalid') ? 'invalid' : toleranceStatuses.includes('failed') ? 'failed' : toleranceStatuses.every(value => value === 'passed') ? 'passed' : 'incomplete';
    return [kind, { status, actualOverlappingInputs: accepted.length, categories, limitMs: PERFORMANCE_POLICY.localP95LimitMs, overLimitInputs, invalidDurations, maximumObservedMs: durations.length && !invalidDurations ? Math.max(...durations) : null, limitedTolerance: { status: toleranceStatus, categories: toleranceCategories } }];
  }));
}

export function freezeConvergenceBounds(idleSamples) {
  if (idleSamples.length < PERFORMANCE_POLICY.idleCalibrationSamples) throw new Error('Idle calibration must finish before fixing convergence bounds.');
  const values = idleSamples.map(sample => sample.privateBytes), p5 = percentile(values, .05), p95 = percentile(values, .95);
  if (p5 === null || p95 === null) throw new Error('Invalid native memory calibration samples.');
  const noiseBytes = p95 - p5;
  return Object.freeze({
    fixedBeforeStabilityRun: true,
    baselineIdleNoiseBytes: noiseBytes,
    tailRangeLimitBytes: Math.max(PERFORMANCE_POLICY.minimumTailRangeBytes, noiseBytes * 2),
    medianGrowthLimitBytes: Math.max(PERFORMANCE_POLICY.minimumMedianGrowthBytes, noiseBytes * 2),
    slopeLimitBytesPerMinute: Math.max(PERFORMANCE_POLICY.minimumSlopeBytesPerMinute, noiseBytes / 10),
    idleCpuLimitPercent: Math.max(PERFORMANCE_POLICY.idleCpuFloorPercent, (percentile(idleSamples.map(sample => sample.idleCpuPercent), .95) ?? 0) + 1),
  });
}

function slopePerMinute(samples) {
  const start = samples[0].elapsedMs, xs = samples.map(sample => (sample.elapsedMs - start) / 60000), ys = samples.map(sample => sample.privateBytes);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length, yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const numerator = xs.reduce((sum, x, i) => sum + (x - xMean) * (ys[i] - yMean), 0), denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  return denominator ? numerator / denominator : 0;
}

export function stabilityVerdict(samples, bounds, warmupCycles) {
  if (!bounds?.fixedBeforeStabilityRun || warmupCycles < PERFORMANCE_POLICY.warmupCycles) return { status: 'incomplete', reason: 'Warmup and predetermined convergence bounds are required.' };
  if (samples.length < 61 || samples.at(-1).elapsedMs - samples[0].elapsedMs < PERFORMANCE_POLICY.stabilityDurationMs) return { status: 'incomplete', reason: 'At least thirty minutes with samples every thirty seconds are required.' };
  if (samples.some(sample => !Number.isFinite(sample.privateBytes) || !Number.isFinite(sample.idleCpuPercent))) return { status: 'invalid', reason: 'Native process accounting is missing.' };
  if (samples.slice(1).some((sample, index) => sample.elapsedMs - samples[index].elapsedMs > PERFORMANCE_POLICY.sampleIntervalMs * 1.5)) return { status: 'incomplete', reason: 'An observation interval exceeded forty-five seconds.' };
  const tail = samples.slice(-PERFORMANCE_POLICY.tailSamples), half = Math.floor(tail.length / 2);
  const tailRangeBytes = Math.max(...tail.map(sample => sample.privateBytes)) - Math.min(...tail.map(sample => sample.privateBytes));
  const medianGrowthBytes = percentile(tail.slice(half).map(sample => sample.privateBytes), .5) - percentile(tail.slice(0, half).map(sample => sample.privateBytes), .5);
  const slopeBytesPerMinute = slopePerMinute(tail), idleP95CpuPercent = percentile(tail.map(sample => sample.idleCpuPercent), .95);
  const cacheSamples = samples.filter(sample => sample.cache && Number.isFinite(sample.cache.bytes) && sample.cache.limitBytes === PERFORMANCE_POLICY.contentCacheLimitBytes);
  const cacheObserved = cacheSamples.length === samples.length;
  const cacheWithinLimit = cacheObserved && cacheSamples.every(sample => sample.cache.bytes >= 0 && sample.cache.bytes <= PERFORMANCE_POLICY.contentCacheLimitBytes);
  const convergence = tailRangeBytes <= bounds.tailRangeLimitBytes && medianGrowthBytes <= bounds.medianGrowthLimitBytes && slopeBytesPerMinute <= bounds.slopeLimitBytesPerMinute;
  return { status: !cacheObserved ? 'incomplete' : convergence && cacheWithinLimit && idleP95CpuPercent <= bounds.idleCpuLimitPercent ? 'passed' : 'failed', tailRangeBytes, medianGrowthBytes, slopeBytesPerMinute, idleP95CpuPercent, cacheWithinLimit, cacheObserved, cacheExercised: cacheSamples.some(sample => sample.cache.bytes > 0), bounds };
}
