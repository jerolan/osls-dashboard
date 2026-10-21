import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GB_SECOND_USD, summarize, fillSeries, estimateCost, totalDurationMs } from '../src/metrics.js';

const labels = ['2026-10-21T00:00:00.000Z', '2026-10-21T00:10:00.000Z'];

function metricsFor() {
  return new Map([['demo-dev-a', {
    inv: { labels, values: [8, 2] },
    err: { labels, values: [1, 0] },
    avg: { labels, values: [100, 200] },
    p99: { labels, values: [150, 250] },
  }]]);
}

test('totalDurationMs weights average duration by invocations per bucket', () => {
  assert.equal(totalDurationMs(metricsFor().get('demo-dev-a')), 1200);
});

test('estimateCost uses billed milliseconds and configured memory', () => {
  const cost = estimateCost({ billedMs: 1000, memoryMB: 1024 });
  assert.ok(Math.abs(cost.usd - DEFAULT_GB_SECOND_USD) < 1e-12);
  assert.equal(cost.gbSeconds, 1);
  const half = estimateCost({ billedMs: 1000, memoryMB: 512 });
  assert.ok(Math.abs(half.usd - cost.usd / 2) < 1e-12);
});

test('summarize totals invocations, errors, p99 and estimated cost', () => {
  const summary = summarize(
    [{ fnName: 'demo-dev-a', memory: 1024 }],
    metricsFor(),
    DEFAULT_GB_SECOND_USD,
    { hours: 1, now: Date.parse('2026-10-21T00:20:00.000Z') },
  );
  assert.equal(summary.totals.functions, 1);
  assert.equal(summary.totals.invocations, 10);
  assert.equal(summary.totals.errors, 1);
  assert.equal(summary.totals.errorRate, 10);
  assert.equal(summary.totals.p99Ms, 250);
  assert.equal(summary.totals.billedMs, 1200);
  assert.ok(summary.totals.costUsd > 0);
  assert.ok(summary.perLambda.get('demo-dev-a').cost.usd > 0);
});

test('fillSeries pads sparse buckets into a full time axis', () => {
  const series = [{ ts: Date.parse('2026-10-21T00:10:00.000Z'), invocations: 3, errors: 0 }];
  const filled = fillSeries(series, { hours: 1, now: Date.parse('2026-10-21T00:20:00.000Z') });
  assert.equal(filled.length, 60);
  assert.equal(filled.at(-1).ts, Date.parse('2026-10-21T00:20:00.000Z'));
  assert.equal(filled.find(p => p.ts === series[0].ts).invocations, 3);
});
