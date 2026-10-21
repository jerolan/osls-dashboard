import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('loadProject parses the demo fixture (service, stage, region, functions)', async () => {
  const p = await loadProject(path.join(here, 'fixtures/demo'));
  assert.equal(p.service, 'demo-service');
  assert.equal(p.stage, 'dev');
  assert.equal(p.region, 'us-east-1');
  assert.equal(p.functions.length, 2);
  const hello = p.functions.find(f => f.key === 'auth');
  assert.equal(hello.runtime, 'nodejs20.x');
  assert.deepEqual(hello.events, ['httpApi']);
});

test('loadProject derives lambda names from the service-stage prefix', async () => {
  const p = await loadProject(path.join(here, 'fixtures/demo'));
  assert.equal(p.functions[0].declaredName, null);
  // resolved name = <service>-<stage>-<key>
  const fn = p.functions[0];
  assert.equal(fn.declaredName ?? (p.service + '-' + p.stage + '-' + fn.key), 'demo-service-dev-auth');
});

test('loadProject rejects non-AWS providers with a clear message', async () => {
  await assert.rejects(
    () => loadProject(path.join(here, 'fixtures/other')),
    /only supports AWS/
  );
});

test('loadProject honors SLS_STAGE and env region overrides', async () => {
  process.env.SLS_STAGE = 'prod';
  process.env.AWS_REGION = 'eu-west-1';
  try {
    const p = await loadProject(path.join(here, 'fixtures/demo'));
    assert.equal(p.stage, 'prod');
    assert.equal(p.region, 'eu-west-1');
  } finally {
    delete process.env.SLS_STAGE;
    delete process.env.AWS_REGION;
  }
});

