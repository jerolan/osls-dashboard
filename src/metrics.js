import { mergeSeries } from './logs.js';

/** us-east-1 on-demand Lambda compute price, USD per GB-second (Oct 2026). */
export const DEFAULT_GB_SECOND_USD = 0.0000166667;

export const sum = metric => (metric?.values ?? []).reduce((a, b) => a + Number(b ?? 0), 0);
export const maxOf = metric => (metric?.values?.length ? Math.max(...metric.values.map(Number)) : null);

export function weightedAverage(metric) {
  if (!metric?.values?.length) return null;
  return metric.values.reduce((a, b) => a + Number(b ?? 0), 0) / metric.values.length;
}

const timeOf = label => (label instanceof Date ? label.getTime() : new Date(label).getTime());

/**
 * Approximate billed milliseconds for one function: sum(avg duration x
 * invocations) per bucket. CloudWatch does not publish a billed-duration
 * metric, so this mirrors Lambda's per-millisecond billing from Duration.
 */
export function totalDurationMs(metrics) {
  const avg = metrics?.avg;
  const inv = metrics?.inv;
  if (!avg?.values?.length) return 0;
  if (!inv?.values?.length) return 0;

  const invByTs = new Map();
  inv.labels.forEach((label, i) => invByTs.set(timeOf(label), Number(inv.values[i] ?? 0)));

  let total = 0;
  let matched = 0;
  avg.labels.forEach((label, i) => {
    const count = invByTs.get(timeOf(label));
    if (count == null) return;
    total += Number(avg.values[i] ?? 0) * count;
    matched += count;
  });

  if (matched > 0) return total;
  // Buckets can be sparse; fall back to the overall average x invocation sum.
  return weightedAverage(avg) * sum(inv);
}

export function estimateCost({ billedMs, memoryMB, pricePerGbSecond = DEFAULT_GB_SECOND_USD }) {
  const gb = (Number(memoryMB) > 0 ? Number(memoryMB) : 1024) / 1024;
  const gbSeconds = (billedMs / 1000) * gb;
  return { usd: gbSeconds * pricePerGbSecond, gbSeconds, billedMs };
}

/** Pad sparse CloudWatch buckets so the chart keeps a real time axis. */
export function fillSeries(series, { hours = 12, now = Date.now() } = {}) {
  const bucketMs = (hours <= 1 ? 60 : hours <= 12 ? 600 : 900) * 1000;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - hours * 3600 * 1000;
  const byTs = new Map((series ?? []).map(p => [p.ts, p]));
  const out = [];
  for (let ts = start + bucketMs; ts <= end; ts += bucketMs) {
    out.push(byTs.get(ts) ?? { ts, invocations: 0, errors: 0 });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Everything the overview needs, computed once per request/window. */
export function summarize(lambdas, metricsByFn, pricePerGbSecond = DEFAULT_GB_SECOND_USD, { hours = 12, now = Date.now() } = {}) {
  let invocations = 0;
  let errors = 0;
  let costUsd = 0;
  let billedMs = 0;
  let p99Ms = 0;
  const perLambda = new Map();

  for (const lambda of lambdas) {
    const metrics = metricsByFn.get(lambda.fnName) ?? null;
    const lambdaInvocations = sum(metrics?.inv);
    const lambdaErrors = sum(metrics?.err);
    const lambdaBilled = totalDurationMs(metrics);
    const cost = estimateCost({ billedMs: lambdaBilled, memoryMB: lambda.memory, pricePerGbSecond });
    const lambdaP99 = maxOf(metrics?.p99) ?? 0;

    invocations += lambdaInvocations;
    errors += lambdaErrors;
    billedMs += lambdaBilled;
    costUsd += cost.usd;
    p99Ms = Math.max(p99Ms, lambdaP99);
    perLambda.set(lambda.fnName, {
      invocations: lambdaInvocations,
      errors: lambdaErrors,
      errorRate: lambdaInvocations > 0 ? (lambdaErrors / lambdaInvocations) * 100 : 0,
      p99Ms: lambdaP99,
      avgMs: weightedAverage(metrics?.avg),
      cost,
    });
  }

  return {
    totals: {
      functions: lambdas.length,
      invocations,
      errors,
      errorRate: invocations > 0 ? (errors / invocations) * 100 : 0,
      p99Ms,
      billedMs,
      costUsd,
      pricePerGbSecond,
    },
    perLambda,
    series: fillSeries(mergeSeries(lambdas, metricsByFn), { hours, now }),
  };
}
