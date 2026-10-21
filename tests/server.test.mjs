import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { DEFAULT_GB_SECOND_USD } from '../src/metrics.js';
import { buildSpans } from '../src/logs.js';
import { cold } from './fixtures/logs/lambda-events.mjs';

const project = {
  service: 'demo',
  stage: 'dev',
  region: 'us-east-1',
  functions: [{ key: 'a', memory: 1024, runtime: 'nodejs20.x', timeout: 6, events: ['httpApi'] }],
};
const lambda = { ...project.functions[0], fnName: 'demo-dev-a' };
const bucket = 10 * 60 * 1000;
const now = Math.floor(Date.now() / bucket) * bucket;
const labels = [new Date(now - bucket).toISOString(), new Date(now).toISOString()];

const providers = {
  resolveLambdas: async () => [lambda],
  pullMetrics: async () => new Map([['demo-dev-a', {
    inv: { labels, values: [8, 2] },
    err: { labels, values: [1, 0] },
    avg: { labels, values: [100, 200] },
    p99: { labels, values: [150, 250] },
  }]]),
  pullEndpoints: async () => ({ status: 'UPDATE_COMPLETE', outputs: { HttpApiUrl: 'https://example.test' } }),
  pullSpans: async () => buildSpans(cold, { fnName: 'demo-dev-a' }),
  pullLogTail: async () => [{ ts: Date.now(), stream: 's', fn: 'demo-dev-a', msg: 'hello' }],
  pullExplorer: async () => ({
    results: [{ fn: 'demo-dev-a', ts: Date.now(), msg: 'hello RequestId 1111' }],
    truncated: false,
  }),
  pullLiveTail: async () => [{ fn: 'demo-dev-a', ts: Date.now() + 1, msg: 'live line', stream: 's' }],
};

async function withServer(fn) {
  const app = buildApp({ project, providers, cacheTtlMs: 0, pricePerGbSecond: DEFAULT_GB_SECOND_USD });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('GET /api/service returns totals, a padded series and estimated cost', async () => {
  await withServer(async base => {
    const res = await fetch(base + '/api/service?window=1h');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.window, '1h');
    assert.equal(json.totals.invocations, 10);
    assert.equal(json.totals.errors, 1);
    assert.ok(json.totals.costUsd > 0);
    assert.equal(json.series.length, 60);
    assert.equal(json.lambdas[0].stats.invocations, 10);
    assert.equal(json.endpoints.HttpApiUrl, 'https://example.test');
  });
});

test('GET /api/service falls back to 12h for an unknown window', async () => {
  await withServer(async base => {
    const json = await (await fetch(base + '/api/service?window=99h')).json();
    assert.equal(json.window, '12h');
    assert.equal(json.series.length, 72);
  });
});

test('GET /api/lambda returns trace spans and detected errors', async () => {
  await withServer(async base => {
    const res = await fetch(base + '/api/lambda/demo-dev-a');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.spans.length, 1);
    assert.equal(json.spans[0].initMs, 115.86);
    assert.equal(json.errors.length, 0);
    assert.equal(json.tail[0].msg, 'hello');
  });
});

test('GET /api/lambda rejects an unknown function', async () => {
  await withServer(async base => {
    const res = await fetch(base + '/api/lambda/not-in-yml');
    assert.equal(res.status, 404);
  });
});

test('GET /api/explorer returns cross-function matches and validates the query', async () => {
  await withServer(async base => {
    const ok = await (await fetch(base + '/api/explorer?q=RequestId')).json();
    assert.equal(ok.results.length, 1);
    assert.equal(ok.fn, 'all');
    const empty = await fetch(base + '/api/explorer?q=');
    assert.equal(empty.status, 400);
  });
});

test('GET /api/logs/stream emits ready and live log events', async () => {
  await withServer(async base => {
    const controller = new AbortController();
    const res = await fetch(base + '/api/logs/stream?fn=all', { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const started = Date.now();
    while (!text.includes('event: log') && Date.now() - started < 6000) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    assert.match(text, /event: ready/);
    assert.match(text, /event: log/);
    assert.match(text, /live line/);
  });
});
