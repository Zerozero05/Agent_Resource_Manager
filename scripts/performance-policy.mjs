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

// Collection budget only. Each category still requires 100 completed overlaps.
export const MAX_NATIVE_CHECK_TASKS = 144;

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

const backgroundCategories = ['search', 'filter', 'tab', 'document'];
const backgroundActions = { check: 'check_now', download: 'apply_resource_download', update: 'apply_resource_update_stage' };
const explicitTimestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;

// Only ordered, distinct observations that finish inside an actual task can
// support a statistical claim. Retain the historical smoke calculation below.
function independentlySampledLoads(records, nativePid, condition, identity) {
  const tally = Object.fromEntries(Object.keys(backgroundActions).map(kind => [kind, { samples: [], rejected: {} }]));
  const owned = identity?.pid === nativePid && Number.isSafeInteger(nativePid) && nativePid > 0
    && Number.isSafeInteger(identity.windowHandle) && identity.windowHandle > 0
    && typeof identity.creationFileTime === 'string' && /^\d+$/.test(identity.creationFileTime);
  const intervals = new Set();
  let lastFinish = 0;
  for (const record of records) {
    if (!Object.hasOwn(tally, record.kind)) continue;
    const entry = tally[record.kind];
    const reject = reason => { entry.rejected[reason] = (entry.rejected[reason] || 0) + 1; };
    const { sample, beforeObservedAtMs: before, afterObservedAtMs: after } = record;
    if (!owned || sample?.pid !== nativePid || sample.windowHandle !== identity.windowHandle
      || sample.creationFileTime !== identity.creationFileTime || sample.foregroundBefore !== true
      || sample.foregroundAfter !== true || sample.condition !== condition) {
      reject('unverified-window'); continue;
    }
    const { startedAtUtcMs: start, finishedAtUtcMs: finish } = sample;
    if (!backgroundCategories.includes(sample.category) || ![before, start, finish, after].every(value => Number.isSafeInteger(value) && value > 0)
      || before > start || start > finish || finish > after) {
      reject('invalid-input-interval'); continue;
    }
    const taskStart = explicitTimestamp(record.taskStartedAt), taskFinish = explicitTimestamp(record.taskFinishedAt);
    if (record.taskAction !== backgroundActions[record.kind] || typeof record.taskId !== 'string' || !record.taskId.trim()
      || record.beforeStatus !== 'running' || !Number.isFinite(taskStart) || taskStart > before
      || (record.afterStatus === 'running' ? record.taskFinishedAt != null
        : record.afterStatus !== 'succeeded' || !Number.isFinite(taskFinish) || taskFinish < finish || taskFinish > after)) {
      reject('not-contained-in-running-task'); continue;
    }
    const key = `${start}:${finish}`;
    if (intervals.has(key) || start < lastFinish) {
      reject('duplicate-or-unordered-input'); continue;
    }
    intervals.add(key);
    lastFinish = finish;
    entry.samples.push(sample);
  }
  return Object.fromEntries(Object.entries(tally).map(([kind, { samples, rejected }]) => {
    const categories = localInteractionVerdict(samples, condition);
    // The local helper retains partial latency values for diagnostics. Do not
    // expose them here as a P95 of a sufficient mixed-load sample population.
    for (const value of Object.values(categories)) {
      if (value.status === 'incomplete') value.p95Ms = null;
    }
    const statuses = Object.values(categories).map(value => value.status);
    const status = statuses.includes('invalid') ? 'invalid' : statuses.includes('failed') ? 'failed'
      : statuses.every(value => value === 'passed') ? 'passed' : 'incomplete';
    return [kind, { status, acceptedInputs: samples.length, rejected, categories }];
  }));
}

// Additional native smoke coverage is intentionally separate from the >=100
// category/P95 gate. A task must actually overlap the input, never merely have
// completed earlier. The normal UI must cover all four categories for each load.
export function backgroundLoadVerdict(records, nativePid, condition = 'native-ui-input-to-painted-result', identity) {
  inputCondition(condition);
  const sampled = independentlySampledLoads(records, nativePid, condition, identity);
  return Object.fromEntries(Object.entries(backgroundActions).map(([kind, action]) => {
    const accepted = records.filter(record => record.kind === kind && record.taskAction === action && ['queued', 'running'].includes(record.beforeStatus) && record.sample?.pid === nativePid && record.sample.condition === condition && record.beforeObservedAtMs <= record.sample.startedAtUtcMs && record.afterObservedAtMs >= record.sample.finishedAtUtcMs && (['queued', 'running'].includes(record.afterStatus) || Date.parse(record.taskFinishedAt || '') >= record.sample.startedAtUtcMs));
    const categories = backgroundCategories.map(category => ({ category, count: accepted.filter(record => record.sample.category === category).length }));
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
    return [kind, { status, actualOverlappingInputs: accepted.length, categories, limitMs: PERFORMANCE_POLICY.localP95LimitMs, overLimitInputs, invalidDurations, maximumObservedMs: durations.length && !invalidDurations ? Math.max(...durations) : null, limitedTolerance: { status: toleranceStatus, categories: toleranceCategories }, sampledOverlap: sampled[kind] }];
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
