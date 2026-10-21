import {
  CloudWatchClient, GetMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand, FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CloudFormationClient, DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { buildSpans, normalizeFilterPattern } from './logs.js';

const HOUR = 3600 * 1000;

function makeClients(region) {
  const opts = { region };
  return {
    cw: new CloudWatchClient(opts),
    cwl: new CloudWatchLogsClient(opts),
    cfn: new CloudFormationClient(opts),
  };
}

/**
 * Resolve candidate lambda names for the service, mostly derived from
 * serverless.yml (default naming <service>-<stage>-<logical>).
 */
export async function resolveLambdas({ service, stage, functions }) {
  const base = service + '-' + stage + '-';
  const list = [];
  for (const f of functions) {
    const fnName = f.declaredName ?? (base + f.key);
    list.push({ ...f, fnName });
  }
  return list;
}

/** Grab CW metrics for a set of lambdas over the last N hours. */
export async function pullMetrics(lambdas, { region, hours = 12, period } = {}) {
  const clients = makeClients(region);
  const end = new Date();
  const start = new Date(end.getTime() - hours * HOUR);
  // 1h -> 1-minute buckets, 12h -> 10-minute, 24h -> 15-minute.
  const bucketSeconds = period ?? (hours <= 1 ? 60 : hours <= 12 ? 600 : 900);
  const cw = clients.cw;

  const queries = [];
  for (const [i, l] of lambdas.entries()) {
    const id = 'l' + i;
    for (const [sfx, stat] of [['inv', 'Sum'], ['err', 'Sum'], ['p99', 'p99'], ['avg', 'Average']]) {
      const mn = sfx === 'p99' || sfx === 'avg' ? 'Duration' : (sfx === 'err' ? 'Errors' : 'Invocations');
      queries.push({
        Id: id + '_' + sfx,
        MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName: mn, Dimensions: [{ Name: 'FunctionName', Value: l.fnName }] }, Period: bucketSeconds, Stat: stat },
        ReturnData: true, Label: l.fnName + ':' + sfx,
      });
    }
  }
  // CW GetMetricData caps at 500 queries per call, send in chunks.
  const results = [];
  for (let i = 0; i < queries.length; i += 400) {
    const res = await cw.send(new GetMetricDataCommand({
      StartTime: start, EndTime: end,
      MetricDataQueries: queries.slice(i, i + 400),
      ScanBy: 'TimestampAscending',
    }));
    results.push(...(res.MetricDataResults ?? []));
  }
  const out = new Map();
  for (const r of results) {
    const label = r.Label || '';
    const idx = label.indexOf(':');
    const key = label.slice(0, idx);
    if (!out.has(key)) out.set(key, {});
    const fn = out.get(key);
    fn[label.slice(idx + 1)] = { labels: r.Timestamps ?? [], values: r.Values ?? [] };
  }
  return out;
}

/** Read recent invocation spans (START/END/REPORT) of a Lambda log group. */
export async function pullSpans(fnName, { region, limit = 200 } = {}) {
  return readSpans('/aws/lambda/' + fnName, fnName, limit, region);
}

async function readSpans(grp, fnName, limit, region) {
  const clients = makeClients(region);
  try {
    const streams = await clients.cwl.send(new DescribeLogStreamsCommand({
      logGroupName: grp,
      orderBy: 'LastEventTime',
      descending: true,
      limit: 10,
    }));
    const spans = [];
    for (const s of streams.logStreams ?? []) {
      if (spans.length >= limit) break;
      // Read the newest events of the stream; init lines precede START and are
      // paired by buildSpans when they fall inside the returned page.
      const res = await clients.cwl.send(new GetLogEventsCommand({
        logGroupName: grp,
        logStreamName: s.logStreamName,
        limit: 1000,
        startFromHead: false,
      }));
      spans.push(...buildSpans(res.events ?? [], { fnName, limit: 500 }));
    }
    return spans.sort((a, b) => a.ts - b.ts).slice(-limit);
  } catch (err) {
    if (String(err?.name) === 'ResourceNotFoundException') return [];
    throw err;
  }
}

/** Read recent log events for one lambda. */
export async function pullLogTail(fnName, { region, since, limit = 200, streams = 3 } = {}) {
  const grp = '/aws/lambda/' + fnName;
  const clients = makeClients(region);
  try {
    const r = await clients.cwl.send(new DescribeLogStreamsCommand({
      logGroupName: grp,
      orderBy: 'LastEventTime',
      descending: true,
      limit: 10,
    }));
    const events = [];
    for (const s of (r.logStreams ?? []).slice(0, streams)) {
      const res = await clients.cwl.send(new GetLogEventsCommand({
        logGroupName: grp,
        logStreamName: s.logStreamName,
        limit: Math.min(Math.max(limit, 50), 1000),
        startTime: since ?? Math.max(0, Date.now() - 6 * HOUR),
        startFromHead: true,
      }));
      for (const e of (res.events ?? [])) {
        events.push({ ts: e.timestamp, stream: s.logStreamName, fn: fnName, msg: String(e.message).trimEnd() });
      }
    }
    events.sort((a, b) => a.ts - b.ts);
    return events.slice(-limit);
  } catch (err) {
    if (String(err?.name) === 'ResourceNotFoundException') return [];
    throw err;
  }
}

/** Merge a short poll across all functions for the cross-function live tail. */
export async function pullLiveTail(lambdas, { region, since, limit = 100 } = {}) {
  if (!lambdas.length) return [];
  const perFn = Math.max(10, Math.ceil(limit / lambdas.length));
  const settled = await Promise.allSettled(
    lambdas.map(l => pullLogTail(l.fnName, { region, since, limit: perFn, streams: 1 })),
  );
  const events = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') events.push(...s.value);
  }
  events.sort((a, b) => a.ts - b.ts);
  return events.slice(-limit);
}

/** Search all log groups of the service with CloudWatch FilterLogEvents. */
export async function pullExplorer(lambdas, { region, q, fnName, hours = 12, limit = 100 } = {}) {
  const targets = fnName ? lambdas.filter(l => l.fnName === fnName) : lambdas;
  if (!targets.length) return { results: [], truncated: false };

  const clients = makeClients(region);
  const startTime = Date.now() - hours * HOUR;
  const perFn = Math.max(25, Math.ceil(limit / targets.length));
  const pattern = normalizeFilterPattern(q);
  const results = [];
  let truncated = false;

  for (let i = 0; i < targets.length; i += 4) {
    const batch = targets.slice(i, i + 4);
    const settled = await Promise.allSettled(batch.map(async l => {
      try {
        const events = [];
        let nextToken;
        let pages = 0;
        do {
          const res = await clients.cwl.send(new FilterLogEventsCommand({
            logGroupName: '/aws/lambda/' + l.fnName,
            filterPattern: pattern,
            startTime,
            limit: Math.min(100, perFn),
            interleaved: true,
            nextToken,
          }));
          events.push(...(res.events ?? []));
          nextToken = res.nextToken;
          pages++;
        } while (nextToken && events.length < perFn && pages < 6);
        return { fn: l.fnName, events: events.slice(0, perFn), more: Boolean(nextToken) };
      } catch (err) {
        if (String(err?.name) === 'ResourceNotFoundException') {
          return { fn: l.fnName, events: [], more: false };
        }
        throw err;
      }
    }));

    for (const s of settled) {
      if (s.status === 'rejected') {
        const err = s.reason;
        if (/InvalidParameter|InvalidFilter/i.test(String(err?.name))) {
          throw new Error('Invalid CloudWatch filter pattern: ' + (err?.message ?? q));
        }
        throw err;
      }
      truncated = truncated || s.value.more;
      for (const e of s.value.events) {
        results.push({ fn: s.value.fn, ts: e.timestamp, stream: e.logStreamName, msg: String(e.message ?? '').trimEnd() });
      }
    }
  }

  results.sort((a, b) => b.ts - a.ts);
  return { results: results.slice(0, limit), truncated, pattern };
}

/** Best-effort read of CloudFormation outputs for endpoints. */
export async function pullEndpoints({ service, stage, region }) {
  const clients = makeClients(region);
  const stack = service + '-' + stage;
  try {
    const res = await clients.cfn.send(new DescribeStacksCommand({ StackName: stack }));
    const s = res.Stacks?.[0];
    const out = {};
    for (const o of s?.Outputs ?? []) {
      if (/ServiceEndpoint|HttpApiUrl|ApiUrl|GraphQLUrl|WebSocketUrl/i.test(o.OutputKey ?? '')) {
        out[o.OutputKey] = o.OutputValue;
      }
    }
    return { status: s?.StackStatus, outputs: out };
  } catch {
    return { status: 'not deployed', outputs: {} };
  }
}
