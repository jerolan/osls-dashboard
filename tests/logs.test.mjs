import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpans, parseReport, classifySpanError, normalizeFilterPattern } from '../src/logs.js';
import { cold, warm, failure, timeout, oom } from './fixtures/logs/lambda-events.mjs';

test('buildSpans keeps a cold start INIT duration separate from handler duration', () => {
  const [span] = buildSpans(cold, { fnName: 'demo-dev-hello' });
  assert.equal(span.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(span.durationMs, 2.58);
  assert.equal(span.billedMs, 119);
  assert.equal(span.initMs, 115.86);
  assert.equal(span.memSizeMB, 1024);
  assert.equal(span.maxMemMB, 67);
  assert.equal(span.error, null);
  assert.deepEqual(span.phases.map(p => p.name), ['INIT', 'START', 'HANDLER', 'END', 'REPORT']);
  assert.equal(span.events.length, 1);
  assert.equal(span.events[0].msg, '2026-10-21T20:00:00.000Z INFO boot');
});

test('buildSpans marks a warm invocation without INIT', () => {
  const [span] = buildSpans(warm, { fnName: 'demo-dev-hello' });
  assert.equal(span.initMs, null);
  assert.equal(span.initStart, null);
  assert.equal(span.durationMs, 1.2);
  assert.equal(span.error, null);
  assert.deepEqual(span.phases.map(p => p.name), ['START', 'HANDLER', 'END', 'REPORT']);
});

test('buildSpans flags an application error and keeps the root-cause line', () => {
  const [span] = buildSpans(failure, { fnName: 'demo-dev-hello' });
  assert.equal(span.status, 'error');
  assert.equal(span.error.kind, 'error');
  assert.match(span.error.message, /boom/);
  assert.equal(span.events.filter(e => e.kind === 'error').length, 2);
});

test('buildSpans classifies timeouts from the log line', () => {
  const [span] = buildSpans(timeout, { fnName: 'demo-dev-hello' });
  assert.equal(span.error.kind, 'timeout');
  assert.match(span.error.message, /Task timed out/);
  assert.equal(span.durationMs, 3000);
});

test('buildSpans classifies an out-of-memory kill', () => {
  const [span] = buildSpans(oom, { fnName: 'demo-dev-hello' });
  assert.equal(span.error.kind, 'memory');
  assert.match(span.error.message, /killed/);
});

test('buildSpans survives two invocations in one stream and flushes an open span', () => {
  const spans = buildSpans([...cold, ...warm.slice(0, 3)], { fnName: 'demo-dev-hello' });
  assert.equal(spans.length, 2);
  assert.equal(spans[1].reportTs, undefined);
  assert.equal(spans[1].end, 6002);
});

test('parseReport tolerates a truncated REPORT line', () => {
  const parsed = parseReport('REPORT RequestId: abc Duration: 1.5 ms Billed Duration: 2 ms');
  assert.equal(parsed.durationMs, 1.5);
  assert.equal(parsed.billedMs, 2);
  assert.equal(parsed.memSizeMB, null);
  assert.equal(parsed.status, null);
});

test('classifySpanError returns null for a healthy span', () => {
  const span = { events: [], status: null, maxMemMB: 10, memSizeMB: 128 };
  assert.equal(classifySpanError(span), null);
});

test('normalizeFilterPattern quotes plain RequestIds and text', () => {
  assert.equal(normalizeFilterPattern('208b5d15-1f37-488b-9d32-d1b672763186'), '"208b5d15-1f37-488b-9d32-d1b672763186"');
  assert.equal(normalizeFilterPattern('Task timed out'), '"Task timed out"');
});

test('normalizeFilterPattern preserves explicit CloudWatch patterns', () => {
  assert.equal(normalizeFilterPattern('"already quoted"'), '"already quoted"');
  assert.equal(normalizeFilterPattern('ERROR && !timeout'), 'ERROR && !timeout');
  assert.equal(normalizeFilterPattern('{ $.level = 50 }'), '{ $.level = 50 }');
});
