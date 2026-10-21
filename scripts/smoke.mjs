#!/usr/bin/env node
/**
 * Real-data smoke check: starts the dashboard against a Serverless project,
 * reads the same APIs the browser uses, and exits non-zero on a broken shape.
 *
 *   AWS_PROFILE=my-profile node scripts/smoke.mjs --cwd examples/demo
 */
import path from 'node:path';
import process from 'node:process';
import { loadProject } from '../src/config.js';
import { buildApp } from '../src/server.js';

const args = process.argv.slice(2);
const cwdIndex = args.indexOf('--cwd');
const root = path.resolve(cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd());

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const project = await loadProject(root);
const app = buildApp({ project, cacheTtlMs: 0 });
const server = await new Promise(resolve => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = 'http://127.0.0.1:' + server.address().port;

async function get(route) {
  const res = await fetch(base + route);
  const json = await res.json();
  check(res.ok, route + ' -> ' + (json.error ?? res.status));
  return json;
}

try {
  const service = await get('/api/service?window=12h&fresh=1');
  check(service.lambdas?.length > 0, 'service has no lambdas');
  check(service.series?.length === 72, '12h series should have 72 buckets, got ' + service.series?.length);
  check(typeof service.totals?.costUsd === 'number', 'missing estimated cost');

  const first = service.lambdas[0];
  const detail = await get('/api/lambda/' + encodeURIComponent(first.fnName));
  check(Array.isArray(detail.spans), 'missing spans');
  const cold = detail.spans.find(s => s.initMs != null);
  check(!cold || cold.durationMs != null, 'cold span lost its handler duration');
  check(!cold || cold.initMs !== cold.durationMs, 'init and handler duration are conflated');

  console.log('SMOKE OK');
  console.log('  service     ' + service.service + ' [' + service.stage + '@' + service.region + ']');
  console.log('  functions   ' + service.lambdas.map(l => l.fnName).join(', '));
  console.log('  invocations ' + service.totals.invocations + '  errors ' + service.totals.errors);
  console.log('  p99         ' + Number(service.totals.p99Ms).toFixed(2) + ' ms');
  console.log('  est. cost   $' + Number(service.totals.costUsd).toFixed(8) + ' (compute only)');
  console.log('  spans       ' + detail.spans.length + '  cold ' + (cold ? 'init ' + cold.initMs + ' ms' : 'not in recent spans'));
} catch (err) {
  console.error('SMOKE FAILED: ' + (err?.message ?? err));
  process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
}
