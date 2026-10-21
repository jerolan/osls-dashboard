import express from 'express';
import path from 'node:path';
import url from 'node:url';
import * as aws from './aws.js';
import { DEFAULT_GB_SECOND_USD, summarize } from './metrics.js';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

export const WINDOWS = {
  '1h': { hours: 1, label: 'last hour' },
  '12h': { hours: 12, label: 'last 12 hours' },
  '24h': { hours: 24, label: 'last 24 hours' },
};

function parseWindow(value) {
  return Object.hasOwn(WINDOWS, value) ? value : '12h';
}

function messageOf(err) {
  const msg = String(err?.message ?? err);
  if (/Could not load credentials|CredentialsProviderError|Unable to locate credentials/i.test(msg)) {
    return msg + ' — configure AWS credentials (or pass --profile <name>).';
  }
  return msg;
}

/** Build the dashboard Express app. Returns the app (not started). */
export function buildApp({
  project,
  providers = aws,
  pricePerGbSecond = DEFAULT_GB_SECOND_USD,
  cacheTtlMs = 15_000,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'ui')));
  app.use(express.json());

  const serviceCache = new Map();
  const liveTail = providers.pullLiveTail ?? aws.pullLiveTail;

  async function lambdas() {
    return providers.resolveLambdas(project);
  }

  async function servicePayload(windowKey, fresh) {
    const hit = serviceCache.get(windowKey);
    if (!fresh && hit && Date.now() - hit.ts < cacheTtlMs) return hit.data;

    const list = await lambdas();
    if (!list.length) {
      throw new Error('No functions found in serverless.yml (functions: block empty or empty yml).');
    }
    const { hours } = WINDOWS[windowKey];
    const [metrics, endpoints] = await Promise.all([
      providers.pullMetrics(list, { region: project.region, hours }),
      providers.pullEndpoints(project).catch(err => ({ status: 'unknown', outputs: {}, error: messageOf(err) })),
    ]);
    const summary = summarize(list, metrics, pricePerGbSecond, { hours });
    const data = {
      service: project.service,
      stage: project.stage,
      region: project.region,
      window: windowKey,
      hours,
      pricePerGbSecond,
      generatedAt: new Date().toISOString(),
      stackStatus: endpoints.status,
      endpoints: endpoints.outputs,
      totals: summary.totals,
      series: summary.series,
      lambdas: list.map(l => ({
        ...l,
        metrics: metrics.get(l.fnName) ?? null,
        stats: summary.perLambda.get(l.fnName) ?? null,
      })),
    };
    serviceCache.set(windowKey, { ts: Date.now(), data });
    return data;
  }

  app.get('/api/service', async (req, res) => {
    try {
      const windowKey = parseWindow(String(req.query.window ?? '12h'));
      res.json(await servicePayload(windowKey, req.query.fresh === '1'));
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  });

  app.get('/api/lambda/:fnName', async (req, res) => {
    try {
      const windowKey = parseWindow(String(req.query.window ?? '12h'));
      const list = await lambdas();
      const fnName = req.params.fnName;
      if (!list.some(l => l.fnName === fnName)) {
        return res.status(404).json({ error: 'Unknown function: ' + fnName });
      }
      const { hours } = WINDOWS[windowKey];
      const [spans, tail] = await Promise.all([
        providers.pullSpans(fnName, { region: project.region }),
        providers.pullLogTail(fnName, { region: project.region, limit: 200 }),
      ]);
      const errors = spans.filter(s => s.error);
      res.json({ fnName, window: windowKey, hours, spans, tail, errors });
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  });

  app.get('/api/explorer', async (req, res) => {
    try {
      const q = String(req.query.q ?? '').trim();
      if (!q) return res.status(400).json({ error: 'A search query is required (?q=RequestId or text).' });
      if (q.length > 256) return res.status(400).json({ error: 'Search query is too long (max 256 characters).' });

      const windowKey = parseWindow(String(req.query.window ?? '12h'));
      const fnName = req.query.fn && req.query.fn !== 'all' ? String(req.query.fn) : null;
      const list = await lambdas();
      if (fnName && !list.some(l => l.fnName === fnName)) {
        return res.status(404).json({ error: 'Unknown function: ' + fnName });
      }
      const { hours } = WINDOWS[windowKey];
      const { results, truncated } = await providers.pullExplorer(list, {
        region: project.region, q, fnName, hours, limit: 100,
      });
      res.json({
        q, fn: fnName ?? 'all', window: windowKey, hours,
        results, truncated, functions: list.map(l => l.fnName),
      });
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  });

  app.get('/api/logs/tail', async (req, res) => {
    try {
      const fnName = String(req.query.fn ?? '');
      const list = await lambdas();
      if (!list.some(l => l.fnName === fnName)) {
        return res.status(404).json({ error: 'Unknown function: ' + fnName });
      }
      const tail = await providers.pullLogTail(fnName, {
        region: project.region,
        since: req.query.since ? Number(req.query.since) : undefined,
      });
      res.json({ fnName, tail });
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  });

  /** Server-sent events: poll CloudWatch every 2 s from the last event. */
  app.get('/api/logs/stream', async (req, res) => {
    let timer = null;
    let closed = false;
    try {
      const list = await lambdas();
      const fnName = req.query.fn && req.query.fn !== 'all' ? String(req.query.fn) : null;
      const targets = fnName ? list.filter(l => l.fnName === fnName) : list;
      if (fnName && !targets.length) return res.status(404).json({ error: 'Unknown function: ' + fnName });
      if (!targets.length) return res.status(400).json({ error: 'No functions found in serverless.yml.' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      const send = (event, data) => {
        if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send('ready', { functions: targets.map(t => t.fnName), fn: fnName ?? 'all' });

      let since = Number(req.query.since) || Date.now();
      const seen = new Set();

      const poll = async () => {
        if (closed) return;
        try {
          const events = fnName
            ? await providers.pullLogTail(targets[0].fnName, { region: project.region, since, limit: 100, streams: 2 })
            : await liveTail(targets, { region: project.region, since, limit: 100 });
          for (const e of events) {
            if (e.ts < since) continue;
            const key = `${e.fn}|${e.stream}|${e.ts}|${e.msg}`;
            if (seen.has(key)) continue;
            seen.add(key);
            send('log', { fn: e.fn, ts: e.ts, msg: e.msg, stream: e.stream });
            if (e.ts > since) since = e.ts;
          }
          if (seen.size > 5000) seen.clear();
          if (!closed) res.write(': keep-alive\n\n');
        } catch (err) {
          send('error', { message: messageOf(err) });
        }
      };

      req.on('close', () => {
        closed = true;
        if (timer) clearInterval(timer);
        res.end();
      });
      await poll();
      if (!closed) timer = setInterval(poll, 2000);
    } catch (err) {
      if (timer) clearInterval(timer);
      if (!res.headersSent) res.status(500).json({ error: messageOf(err) });
      else res.end();
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: project.service, stage: project.stage, region: project.region });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));

  return app;
}
