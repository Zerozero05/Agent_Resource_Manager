import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PERFORMANCE_POLICY } from '../scripts/performance-policy.mjs';

const source = await readFile(new URL('../scripts/verify-uia-performance.mjs', import.meta.url), 'utf8');

test('the fixed preparation is recorded before collecting calibration samples', () => {
  assert.match(source, /stabilityPreparationIdleMs = 120000/);
  const start = source.indexOf('async function stabilityRun');
  const warmup = source.indexOf('i < policy.warmupCycles', start);
  const preparation = source.indexOf("await emit('fixed-stability-preparation'", start);
  const idle = source.indexOf('await sleep(report.measurement.stabilityPreparationIdleMs)', start);
  const calibration = source.indexOf('i < policy.idleCalibrationSamples', start);
  const bounds = source.indexOf('freezeConvergenceBounds(idle)', start);
  assert.ok(start < warmup && warmup < preparation && preparation < idle && idle < calibration && calibration < bounds);
  assert.match(source.slice(preparation, calibration), /adaptive: false/);
});

test('the original sample counts and acceptance thresholds remain unchanged', () => {
  assert.equal(PERFORMANCE_POLICY.warmupCycles, 5);
  assert.equal(PERFORMANCE_POLICY.idleCalibrationSamples, 11);
  assert.equal(PERFORMANCE_POLICY.stabilityDurationMs, 1800000);
  assert.equal(PERFORMANCE_POLICY.sampleIntervalMs, 30000);
  assert.equal(PERFORMANCE_POLICY.minimumTailRangeBytes, 33554432);
  assert.equal(PERFORMANCE_POLICY.minimumMedianGrowthBytes, 16777216);
  assert.equal(PERFORMANCE_POLICY.minimumSlopeBytesPerMinute, 524288);
});
