/**
 * Pure parsers for CloudWatch Logs output produced by AWS Lambda.
 *
 * Lambda writes START / END / REPORT control lines around every invocation
 * and INIT_START before a cold start. Keeping the parsing here (instead of in
 * the AWS client) makes the trace, live tail and error views testable without
 * credentials or network access.
 */

const REQUEST_ID = /RequestId:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function numberAfter(pattern, message) {
  const m = pattern.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function parseRequestId(message) {
  return REQUEST_ID.exec(String(message))?.[1] ?? null;
}

/** Parse the fields of a Lambda REPORT line. Missing fields stay null. */
export function parseReport(message) {
  const m = String(message);
  return {
    durationMs: numberAfter(/(?<!Billed )Duration:\s*([0-9.]+)\s*ms/i, m),
    billedMs: numberAfter(/Billed Duration:\s*([0-9.]+)\s*ms/i, m),
    memSizeMB: numberAfter(/Memory Size:\s*([0-9]+)\s*MB/i, m),
    maxMemMB: numberAfter(/Max Memory Used:\s*([0-9]+)\s*MB/i, m),
    initMs: numberAfter(/Init Duration:\s*([0-9.]+)\s*ms/i, m),
    status: /Status:\s*(error|success)/i.exec(m)?.[1]?.toLowerCase() ?? null,
    errorType: /Error Type:\s*(\S+)/.exec(m)?.[1] ?? null,
  };
}

export function isErrorLine(message) {
  return /(^|\s)(ERROR|\[ERROR\]|Error:|Exception|Unhandled)|Task timed out|Runtime exited with error|out of memory|\bOOM\b/i.test(
    String(message),
  );
}

/**
 * CloudWatch filter patterns treat punctuation such as the hyphens in a
 * RequestId as syntax. Plain user text is therefore sent as an exact phrase;
 * explicit patterns (quoted, JSON, wildcard or boolean) pass through.
 */
export function normalizeFilterPattern(q) {
  const text = String(q ?? '').trim();
  if (!text) return text;
  if (/^["{\[]/.test(text) || /&&|\|\|/.test(text) || text.includes('"')) return text;
  return '"' + text + '"';
}

/**
 * Classify a failed invocation from REPORT fields and application log lines.
 * Returns null for a healthy span.
 */
export function classifySpanError(span) {
  const lines = (span.events ?? []).map(e => String(e.msg));
  const timeout = lines.find(m => /Task timed out after/i.test(m));
  if (timeout) return { kind: 'timeout', message: timeout };

  const killed = lines.find(m => /Runtime exited with error|signal: killed|out of memory|\bOOM\b/i.test(m));
  const atLimit = span.maxMemMB != null && span.memSizeMB != null && span.maxMemMB >= span.memSizeMB;
  if (atLimit && (killed || /out of memory|\bOOM\b/i.test(lines.join('\n')))) {
    return { kind: 'memory', message: killed ?? `Max memory used ${span.maxMemMB} MB of ${span.memSizeMB} MB` };
  }
  if (killed && /out of memory|\bOOM\b/i.test(killed)) return { kind: 'memory', message: killed };
  if (killed) return { kind: 'runtime', message: killed };
  if (span.errorType && /Runtime\.ExitError|OutOfMemory/i.test(span.errorType)) {
    return { kind: /OutOfMemory/i.test(span.errorType) ? 'memory' : 'runtime', message: `Error Type: ${span.errorType}` };
  }
  if (atLimit) return { kind: 'memory', message: `Max memory used ${span.maxMemMB} MB of ${span.memSizeMB} MB` };
  if (span.status === 'error') {
    const appLine = (span.events ?? []).find(e => e.kind === 'error');
    return { kind: 'error', message: appLine?.msg ?? 'Invocation reported Status: error' };
  }
  return null;
}

function finishSpan(span) {
  if (!span) return null;
  const end = span.end ?? span.reportTs ?? span.start;
  span.end = end;
  span.durationMs = span.durationMs ?? (end != null && span.start != null ? Math.max(0, end - span.start) : null);
  if (span.initMs == null && span.initStart != null && span.start != null) {
    span.initMs = Math.max(0, span.start - span.initStart);
  }
  const phases = [];
  if (span.initStart != null) {
    phases.push({ name: 'INIT', start: span.initStart, end: span.initMs != null ? span.initStart + span.initMs : span.start, ms: span.initMs });
  }
  phases.push({ name: 'START', at: span.start });
  phases.push({ name: 'HANDLER', start: span.start, end, ms: span.durationMs });
  phases.push({ name: 'END', at: end });
  if (span.reportTs != null) phases.push({ name: 'REPORT', at: span.reportTs });
  span.phases = phases;
  span.error = classifySpanError(span);
  if (span.error) span.status = span.status ?? 'error';
  return span;
}

/**
 * Turn raw CloudWatch Logs events from one stream into invocation spans with
 * INIT/START/HANDLER/END/REPORT phases and an optional error classification.
 */
export function buildSpans(rawEvents, { fnName = null, limit = 200 } = {}) {
  const events = [...(rawEvents ?? [])]
    .filter(e => e && e.message != null && String(e.message).trim() !== '')
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  const spans = [];
  let cur = null;
  let initStart = null;
  let initEvents = [];

  for (const event of events) {
    const msg = String(event.message).trim();
    const ts = event.timestamp ?? null;

    if (msg.startsWith('INIT_START')) {
      initStart = ts;
      initEvents = [];
      continue;
    }

    if (msg.startsWith('START RequestId: ')) {
      if (cur) spans.push(finishSpan(cur));
      cur = {
        id: parseRequestId(msg) ?? `start-${ts}`,
        fn: fnName,
        ts,
        start: ts,
        initStart,
        initEvents,
        events: [],
        stream: event.logStreamName ?? null,
        status: null,
        errorType: null,
      };
      initStart = null;
      initEvents = [];
      continue;
    }

    if (!cur) continue;

    if (msg.startsWith('END RequestId: ')) {
      cur.end = ts;
      continue;
    }

    if (msg.startsWith('REPORT RequestId: ')) {
      Object.assign(cur, parseReport(msg));
      cur.reportTs = ts;
      spans.push(finishSpan(cur));
      cur = null;
      continue;
    }

    cur.events.push({ ts, msg, kind: isErrorLine(msg) ? 'error' : 'log' });
  }
  if (cur) spans.push(finishSpan(cur));

  return spans
    .filter(Boolean)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    .slice(-limit);
}

/** Merge buckets from several lambdas into one invocation/error series. */
export function mergeSeries(lambdas, metricsByFn) {
  const byTs = new Map();
  const add = (metric, field) => {
    if (!metric?.labels || !metric?.values) return;
    metric.labels.forEach((label, i) => {
      const ts = label instanceof Date ? label.getTime() : new Date(label).getTime();
      if (!Number.isFinite(ts)) return;
      const bucket = byTs.get(ts) ?? { ts, invocations: 0, errors: 0 };
      bucket[field] += Number(metric.values[i] ?? 0);
      byTs.set(ts, bucket);
    });
  };
  for (const lambda of lambdas) {
    const metrics = metricsByFn.get(lambda.fnName);
    add(metrics?.inv, 'invocations');
    add(metrics?.err, 'errors');
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}
