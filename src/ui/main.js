const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const pct = n => (n == null ? '—' : (n > 0 && n < 0.01 ? '<0.01' : Number(n).toFixed(2)) + '%');
const usd = n => {
  if (n == null) return '—';
  if (n === 0) return '$0.00';
  if (n < 0.0001) return '$' + Number(n).toFixed(7);
  if (n < 0.01) return '$' + Number(n).toFixed(5);
  if (n < 1) return '$' + Number(n).toFixed(4);
  return '$' + Number(n).toFixed(2);
};
const time = ts => (ts == null ? '—' : new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
const dateTime = ts => (ts == null ? '—' : new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
const isErrorLine = msg => /(^|\s)(ERROR|\[ERROR\]|Error:|Exception|Unhandled)|Task timed out|Runtime exited with error|out of memory|\bOOM\b/i.test(String(msg));
const isSystemLine = msg => /^(START|END|REPORT|INIT_START)/.test(String(msg));

const WINDOWS = ['1h', '12h', '24h'];
const WINDOW_LABEL = { '1h': 'last hour', '12h': 'last 12 hours', '24h': 'last 24 hours' };
const BUCKETS = { '1h': '1-minute buckets', '12h': '10-minute buckets', '24h': '15-minute buckets' };

function storedWindow() {
  try {
    const w = localStorage.getItem('osls.window');
    return WINDOWS.includes(w) ? w : '12h';
  } catch { return '12h'; }
}

const state = { data: null, window: storedWindow(), live: null };
let routeToken = 0;

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) throw new Error(json?.error || 'Request failed (' + res.status + ')');
  if (json?.error) throw new Error(json.error);
  return json;
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError() {
  const el = document.getElementById('error');
  el.classList.add('hidden');
  el.textContent = '';
}

function emptyState(text, hint = '') {
  return `<div class='flex flex-col items-center justify-center gap-1 rounded-box border border-dashed border-base-300 px-6 py-10 text-center'>
    <div class='text-2xl text-base-content/25'>◇</div>
    <p class='text-sm text-base-content/60'>${esc(text)}</p>
    ${hint ? `<p class='max-w-md text-xs text-base-content/40'>${esc(hint)}</p>` : ''}
  </div>`;
}

function renderSkeleton() {
  document.getElementById('page').innerHTML = `<div class='flex min-h-[40vh] flex-col items-center justify-center gap-3 text-base-content/50'>
    <span class='loading loading-spinner loading-md text-primary'></span>
    <p class='text-sm'>Reading CloudWatch…</p>
  </div>`;
}

async function loadService(fresh = false) {
  clearError();
  if (!state.data) renderSkeleton();
  try {
    state.data = await api('/api/service?window=' + state.window + (fresh ? '&fresh=1' : ''));
    updateChrome();
    route();
  } catch (e) {
    showError(e.message);
    if (!state.data) document.getElementById('page').innerHTML = emptyState('Could not read your AWS data', e.message);
  }
}

function updateChrome() {
  const d = state.data;
  const meta = document.getElementById('meta');
  meta.textContent = d.service + ' · ' + d.stage + '@' + d.region;
  meta.title = d.service + ' · ' + d.stage + ' @ ' + d.region + ' · ' + (d.stackStatus ?? 'unknown');
  document.getElementById('window-badge').textContent = state.window;
  document.getElementById('crumb-service').textContent = d.service;
}

function parseHash() {
  const raw = (location.hash || '#/').slice(1) || '/';
  const [path, query = ''] = raw.split('?');
  return { path: path || '/', params: new URLSearchParams(query) };
}

function route() {
  const token = ++routeToken;
  const { path, params } = parseHash();
  const base = path.startsWith('/fn/') ? '/functions' : path;
  $$('#nav a[data-route]').forEach(a => {
    const active = a.dataset.route === base;
    a.classList.toggle('menu-active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const names = { '/': 'Overview', '/functions': 'Functions', '/explorer': 'Explorer', '/live': 'Live tail' };
  let name = names[path] ?? 'Not found';
  if (path.startsWith('/fn/')) name = decodeURIComponent(path.slice(4));
  document.getElementById('crumb-page').textContent = name;

  if (!state.data) return;
  if (path.startsWith('/fn/')) return renderFn(decodeURIComponent(path.slice(4)), token);
  if (path === '/functions') return renderFunctions();
  if (path === '/explorer') return renderExplorer(params, token);
  if (path === '/live') return renderLive(params);
  if (path === '/') return renderOverview();
  document.getElementById('page').innerHTML = emptyState('Page not found', 'Use the navigation on the left.');
}

function onClick(e) {
  const win = e.target.closest('[data-window]');
  if (win) { e.preventDefault(); setWindow(win.dataset.window); return; }
  const live = e.target.closest('[data-live-start]');
  if (live) { startLive(live.dataset.liveStart); return; }
  const stop = e.target.closest('[data-live-stop]');
  if (stop) { stopLive(); return; }
  const row = e.target.closest('tr[data-fn]');
  if (row && !e.target.closest('a')) location.hash = '#/fn/' + encodeURIComponent(row.dataset.fn);
}

function onSubmit(e) {
  if (e.target.id !== 'explorer-form') return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const q = String(fd.get('q') ?? '').trim();
  const fn = String(fd.get('fn') ?? 'all');
  const next = '#/explorer?q=' + encodeURIComponent(q) + '&fn=' + encodeURIComponent(fn);
  if (location.hash === next) route();
  else location.hash = next;
}

function setWindow(w) {
  if (!WINDOWS.includes(w) || w === state.window) return;
  state.window = w;
  try { localStorage.setItem('osls.window', w); } catch {}
  document.getElementById('window-badge').textContent = w;
  loadService(true);
}

function windowPicker() {
  return `<div class='join' role='group' aria-label='Metrics window'>${WINDOWS.map(w =>
    `<button type='button' class='btn join-item btn-sm ${state.window === w ? 'btn-active btn-primary' : ''}' data-window='${w}' aria-pressed='${state.window === w}'>${w}</button>`,
  ).join('')}</div>`;
}

function stat(label, value, tone = '', desc = '') {
  return `<div class='stat'>
    <div class='stat-title text-xs'>${esc(label)}</div>
    <div class='stat-value text-2xl ${tone}'>${value}</div>
    <div class='stat-desc'>${desc ? esc(desc) : '&nbsp;'}</div>
  </div>`;
}

function renderOverview() {
  const d = state.data;
  const t = d.totals;
  const eps = Object.entries(d.endpoints ?? {});
  document.getElementById('page').innerHTML = `
    <div class='mb-6 flex flex-wrap items-end justify-between gap-4'>
      <div>
        <h1 class='text-2xl font-semibold tracking-tight'>Overview</h1>
        <p class='mt-1 text-sm text-base-content/50'>${esc(d.service)} · ${esc(d.stage)} @ ${esc(d.region)}</p>
      </div>
      ${windowPicker()}
    </div>
    <div class='stats stats-vertical w-full overflow-x-auto border border-base-300 bg-base-100 shadow-sm sm:stats-horizontal'>
      ${stat('Invocations', fmt(t.invocations), 'text-primary', WINDOW_LABEL[state.window])}
      ${stat('Errors', fmt(t.errors), t.errors > 0 ? 'text-error' : 'text-success', pct(t.errorRate) + ' error rate')}
      ${stat('Worst p99', t.p99Ms ? fmt(t.p99Ms, 2) + ' ms' : '—', '', 'duration')}
      ${stat('Est. cost', usd(t.costUsd), '', 'approx. compute only')}
      ${stat('Functions', fmt(t.functions), '', eps.length + ' endpoint' + (eps.length === 1 ? '' : 's'))}
    </div>
    <div class='mt-6 grid gap-6 lg:grid-cols-3'>
      <div class='card border border-base-300 bg-base-100 shadow-sm lg:col-span-2'>${chartCard()}</div>
      ${endpointCard(eps, d)}
    </div>
    <div class='card mt-6 border border-base-300 bg-base-100 shadow-sm'>
      <div class='card-body'>
        <div class='flex flex-wrap items-center justify-between gap-2'>
          <div><h2 class='card-title text-base'>Functions</h2><p class='text-xs text-base-content/50'>${WINDOW_LABEL[state.window]} · from serverless.yml</p></div>
          <a class='btn btn-ghost btn-sm' href='#/functions'>View all</a>
        </div>
        ${functionsTable(d.lambdas, 6)}
      </div>
    </div>`;
}

function chartCard() {
  const t = state.data.totals;
  return `<div class='card-body'>
    <div class='flex flex-wrap items-start justify-between gap-2'>
      <div><h2 class='card-title text-base'>Invocations</h2><p class='text-xs text-base-content/50'>${WINDOW_LABEL[state.window]} · ${BUCKETS[state.window]}</p></div>
      <div class='flex flex-wrap gap-2'>
        <span class='badge badge-primary badge-sm'>${fmt(t.invocations)} invocations</span>
        <span class='badge ${t.errors ? 'badge-error' : 'badge-success'} badge-sm'>${fmt(t.errors)} errors</span>
      </div>
    </div>
    ${chartSvg(state.data.series)}
  </div>`;
}

function chartSvg(series) {
  const pts = Array.isArray(series) ? series : [];
  if (!pts.length) return emptyState('No invocation data yet', 'Trigger the service or widen the window.');
  if (!pts.some(p => Number(p.invocations) > 0)) {
    return emptyState('No invocations in this window', 'Trigger the service or widen the window to 24h.');
  }
  const W = 800, H = 220, padL = 42, padR = 12, padT = 16, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(1, ...pts.map(p => Number(p.invocations) || 0));
  const step = plotW / pts.length;
  const bw = Math.max(3, Math.min(22, step * 0.72));
  const y = v => padT + plotH - (v / maxV) * plotH;
  const grid = [0, 0.5, 1].map(f => {
    const yy = padT + plotH * (1 - f);
    return `<line x1='${padL}' y1='${yy}' x2='${W - padR}' y2='${yy}' class='stroke-base-300' stroke-dasharray='3 5' stroke-width='1'/>` +
      `<text x='${padL - 8}' y='${yy + 3}' text-anchor='end' class='fill-base-content/40 text-[10px]'>${fmt(maxV * f)}</text>`;
  }).join('');
  const bars = pts.map((p, i) => {
    const inv = Number(p.invocations) || 0;
    const err = Number(p.errors) || 0;
    const x = padL + step * i + (step - bw) / 2;
    const h = inv > 0 ? Math.max(4, (inv / maxV) * plotH) : 0;
    const eh = err > 0 ? Math.max(2, (err / maxV) * plotH) : 0;
    const tip = dateTime(p.ts) + ' — ' + fmt(inv) + ' invocations, ' + fmt(err) + ' errors';
    const invBar = h > 0 ? `<rect x='${x}' y='${y(inv)}' width='${bw}' height='${h}' rx='2' class='fill-primary hover:fill-primary/80'><title>${esc(tip)}</title></rect>` : '';
    const errBar = eh > 0 ? `<rect x='${x}' y='${y(err)}' width='${bw}' height='${Math.min(h || eh, eh)}' rx='2' class='fill-error'><title>${esc(tip)}</title></rect>` : '';
    return invBar + errBar;
  }).join('');
  const first = pts[0].ts, last = pts[pts.length - 1].ts;
  const labels = `<text x='${padL}' y='${H - 8}' class='fill-base-content/40 text-[10px]'>${esc(dateTime(first))}</text>` +
    `<text x='${W - padR}' y='${H - 8}' text-anchor='end' class='fill-base-content/40 text-[10px]'>${esc(dateTime(last))}</text>`;
  return `<svg viewBox='0 0 ${W} ${H}' role='img' aria-label='Invocations and errors over ${WINDOW_LABEL[state.window]}' class='mt-4 h-52 w-full'>${grid}${bars}${labels}</svg>`;
}

function endpointCard(eps, d) {
  const status = d.stackStatus ?? 'unknown';
  const cls = /COMPLETE/.test(status) && !/ROLLBACK/.test(status) ? 'badge-success'
    : /IN_PROGRESS/.test(status) ? 'badge-warning'
      : /FAILED|ROLLBACK/.test(status) ? 'badge-error' : 'badge-ghost';
  return `<div class='card border border-base-300 bg-base-100 shadow-sm'>
    <div class='card-body gap-4'>
      <div class='flex items-center justify-between gap-2'>
        <h2 class='card-title text-base'>Endpoints</h2>
        <span class='badge ${cls} badge-sm'>${esc(status)}</span>
      </div>
      ${eps.length ? `<div class='space-y-2'>${eps.map(([k, v]) => `<a class='link link-primary block break-all font-mono text-xs' href='${esc(v)}' target='_blank' rel='noopener noreferrer'>${esc(k)}<span class='block text-base-content/50'>${esc(v)}</span></a>`).join('')}</div>`
    : emptyState('No HTTP endpoints', 'Deploy the service to populate CloudFormation outputs.')}
      <p class='mt-auto text-xs text-base-content/40'>Stack <code class='font-mono'>${esc(d.service)}-${esc(d.stage)}</code></p>
    </div>
  </div>`;
}

function functionsTable(lams, limit) {
  const rows = limit ? lams.slice(0, limit) : lams;
  if (!rows.length) return emptyState('No functions found', 'Check the functions block in serverless.yml.');
  return `<div class='overflow-x-auto'><table class='table table-sm'>
    <thead><tr>
      <th>Function</th><th>Runtime</th><th class='text-right'>Memory</th>
      <th class='text-right'>Invocations</th><th class='text-right'>Errors</th>
      <th class='text-right'>Error rate</th><th class='text-right'>p99</th>
      <th class='text-right'>Avg</th><th class='text-right'>Est. cost</th>
    </tr></thead>
    <tbody>${rows.map(l => {
      const s = l.stats ?? {};
      return `<tr class='hover' data-fn='${esc(l.fnName)}'>
        <td><a class='link link-hover font-medium' href='#/fn/${encodeURIComponent(l.fnName)}'>${esc(l.fnName)}</a><div class='text-[11px] text-base-content/40'>${esc((l.events ?? []).join(', ') || 'no events')}</div></td>
        <td><span class='badge badge-ghost badge-sm'>${esc(l.runtime ?? '—')}</span></td>
        <td class='text-right font-mono text-xs'>${fmt(l.memory ?? 1024)} MB</td>
        <td class='text-right font-mono text-xs'>${fmt(s.invocations)}</td>
        <td class='text-right'><span class='badge ${s.errors > 0 ? 'badge-error' : 'badge-success'} badge-sm'>${fmt(s.errors)}</span></td>
        <td class='text-right font-mono text-xs ${s.errors > 0 ? 'text-error' : 'text-base-content/50'}'>${pct(s.errorRate)}</td>
        <td class='text-right font-mono text-xs'>${s.p99Ms ? fmt(s.p99Ms, 2) + ' ms' : '—'}</td>
        <td class='text-right font-mono text-xs'>${s.avgMs != null ? fmt(s.avgMs, 2) + ' ms' : '—'}</td>
        <td class='text-right font-mono text-xs'>${usd(s.cost?.usd)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function renderFunctions() {
  const d = state.data;
  document.getElementById('page').innerHTML = `
    <div class='mb-6 flex flex-wrap items-end justify-between gap-4'>
      <div><h1 class='text-2xl font-semibold tracking-tight'>Functions</h1><p class='mt-1 text-sm text-base-content/50'>${d.lambdas.length} function${d.lambdas.length === 1 ? '' : 's'} · ${WINDOW_LABEL[state.window]}</p></div>
      ${windowPicker()}
    </div>
    <div class='card border border-base-300 bg-base-100 shadow-sm'><div class='card-body'>${functionsTable(d.lambdas)}</div></div>`;
}

async function renderFn(name, token) {
  const l = state.data.lambdas.find(x => x.fnName === name);
  if (!l) { document.getElementById('page').innerHTML = emptyState('Unknown function', name); return; }
  const s = l.stats ?? {};
  document.getElementById('page').innerHTML = `
    <div class='mb-6 flex flex-wrap items-center gap-3'>
      <a href='#/functions' class='btn btn-ghost btn-sm'>← Functions</a>
      <h1 class='min-w-0 break-all font-mono text-xl font-semibold'>${esc(name)}</h1>
      <span class='badge badge-outline'>${esc(l.runtime ?? 'runtime?')}</span>
      <span class='badge badge-outline'>${fmt(l.memory ?? 1024)} MB</span>
      <span class='badge badge-outline'>${fmt(l.timeout ?? 6)} s timeout</span>
      <div class='ml-auto'>${windowPicker()}</div>
    </div>
    <div class='stats stats-vertical w-full overflow-x-auto border border-base-300 bg-base-100 shadow-sm sm:stats-horizontal'>
      ${stat('Invocations', fmt(s.invocations), 'text-primary', WINDOW_LABEL[state.window])}
      ${stat('Errors', fmt(s.errors), s.errors > 0 ? 'text-error' : 'text-success', pct(s.errorRate) + ' error rate')}
      ${stat('p99', s.p99Ms ? fmt(s.p99Ms, 2) + ' ms' : '—', '', 'duration')}
      ${stat('Average', s.avgMs != null ? fmt(s.avgMs, 2) + ' ms' : '—', '', 'duration')}
      ${stat('Est. cost', usd(s.cost?.usd), '', 'approx. compute only')}
    </div>
    <div class='mt-6 grid gap-6 lg:grid-cols-3'>
      <div class='space-y-6 lg:col-span-2'>
        <div class='card border border-base-300 bg-base-100 shadow-sm'><div class='card-body'>
          <h2 class='card-title text-base'>Errors</h2>
          <div id='fn-errors'><div class='flex items-center gap-2 text-sm text-base-content/50'><span class='loading loading-spinner loading-xs'></span> Reading reports…</div></div>
        </div></div>
        <div class='card border border-base-300 bg-base-100 shadow-sm'><div class='card-body'>
          <div class='flex flex-wrap items-center justify-between gap-2'>
            <div><h2 class='card-title text-base'>Recent invocations</h2><p class='text-xs text-base-content/50'>Expand a row for its INIT → START → END → REPORT trace.</p></div>
            <span class='badge badge-ghost badge-sm'>latest 200</span>
          </div>
          <div id='spans'><div class='flex items-center gap-2 py-6 text-sm text-base-content/50'><span class='loading loading-spinner loading-xs'></span> Reading log streams…</div></div>
        </div></div>
      </div>
      <div class='space-y-6'>
        <div class='card border border-base-300 bg-base-100 shadow-sm'><div class='card-body gap-3'>
          <div class='flex items-center justify-between gap-2'><h2 class='card-title text-base'>Live tail</h2><span id='live-badge' class='badge badge-ghost badge-sm'>IDLE</span></div>
          <p class='text-xs text-base-content/50'>Streams new CloudWatch events every 2 seconds.</p>
          <div class='flex gap-2'>
            <button type='button' class='btn btn-primary btn-sm' data-live-start='${esc(name)}'>Start live</button>
            <button type='button' class='btn btn-ghost btn-sm hidden' data-live-stop>Stop</button>
          </div>
          <div id='live-logs' class='log-pane min-h-32'><span class='text-base-content/40' data-empty>Not streaming.</span></div>
        </div></div>
        <div class='card border border-base-300 bg-base-100 shadow-sm'><div class='card-body gap-3'>
          <h2 class='card-title text-base'>Recent logs</h2>
          <div id='tail' class='log-pane'><span class='text-base-content/40' data-empty>Loading…</span></div>
        </div></div>
      </div>
    </div>`;
  renderLiveControls(false);
  try {
    const data = await api('/api/lambda/' + encodeURIComponent(name) + '?window=' + state.window);
    if (token !== routeToken) return;
    renderErrors(data.errors ?? []);
    renderSpans(data.spans ?? []);
    renderTail(data.tail ?? []);
  } catch (e) {
    if (token !== routeToken) return;
    document.getElementById('spans').innerHTML = `<div class='alert alert-error text-sm'>${esc(e.message)}</div>`;
    document.getElementById('fn-errors').innerHTML = `<div class='text-sm text-base-content/50'>Could not read invocation reports.</div>`;
  }
}

function renderErrors(errors) {
  const el = document.getElementById('fn-errors');
  if (!el) return;
  if (!errors.length) {
    el.innerHTML = `<div class='alert alert-success py-3 text-sm'><span>No failed invocations in the recent spans.</span></div>`;
    return;
  }
  el.innerHTML = `<div class='space-y-2'>${errors.slice(0, 8).map(sp => `<div class='alert alert-error items-start py-3'>
    <div class='min-w-0'>
      <div class='flex flex-wrap items-center gap-2'>
        <span class='badge badge-error badge-sm'>${esc(sp.error.kind)}</span>
        <span class='font-mono text-xs'>${esc((sp.id ?? '').slice(0, 8))}</span>
        <span class='text-xs opacity-70'>${esc(dateTime(sp.ts))}</span>
      </div>
      <p class='mt-1 break-words text-xs'>${esc(sp.error.message)}</p>
    </div>
  </div>`).join('')}</div>
  ${errors.length > 8 ? `<p class='mt-2 text-xs text-base-content/50'>Showing 8 of ${errors.length} failed invocations.</p>` : ''}`;
}

function renderSpans(spans) {
  const el = document.getElementById('spans');
  if (!el) return;
  if (!spans.length) {
    el.innerHTML = emptyState('No invocations in recent log streams', 'The function may not have run, or its log group is outside the retention window.');
    return;
  }
  const shown = spans.slice().reverse().slice(0, 60);
  const coldAt = shown.findIndex(sp => sp.initMs != null);
  const openAt = coldAt >= 0 ? coldAt : 0;
  el.innerHTML = `<div class='space-y-2'>${shown.map((sp, i) => spanRow(sp, i, openAt)).join('')}</div>` +
    (spans.length > 60 ? `<p class='mt-2 text-xs text-base-content/50'>Showing the latest 60 of ${spans.length} spans.</p>` : '');
}

function spanRow(sp, index = 0, openAt = 0) {
  const cold = sp.initMs != null;
  return `<details class='collapse collapse-arrow border border-base-300 bg-base-100' ${index === openAt || sp.error ? 'open' : ''}>
    <summary class='collapse-title flex flex-wrap items-center gap-2 py-3 pr-10'>
      <span class='font-mono text-xs text-base-content/50'>${esc(time(sp.ts))}</span>
      <span class='font-mono text-xs'>${esc((sp.id ?? '').slice(0, 8))}</span>
      ${sp.error ? `<span class='badge badge-error badge-sm'>${esc(sp.error.kind)}</span>` : `<span class='badge badge-success badge-outline badge-sm'>ok</span>`}
      ${cold ? `<span class='badge badge-warning badge-outline badge-sm'>cold · init ${fmt(sp.initMs, 0)} ms</span>` : ''}
      <span class='ml-auto font-mono text-xs font-semibold'>${fmt(sp.durationMs, 2)} ms</span>
      <span class='font-mono text-[11px] text-base-content/50'>billed ${fmt(sp.billedMs)} ms</span>
    </summary>
    <div class='collapse-content space-y-4'>
      ${traceBlock(sp)}
      ${sp.error ? `<div class='alert alert-error py-3'><div><span class='badge badge-error badge-sm mr-2'>${esc(sp.error.kind)}</span><span class='text-xs'>${esc(sp.error.message)}</span></div></div>` : ''}
      ${spanLogs(sp)}
    </div>
  </details>`;
}

function traceBlock(sp) {
  const init = Number(sp.initMs) || 0;
  const handler = Number(sp.durationMs) || 0;
  const total = Math.max(1, init + handler);
  const initPct = init > 0 ? Math.max(3, (init / total) * 100) : 0;
  const handlerPct = 100 - initPct;
  const mem = sp.maxMemMB != null && sp.memSizeMB ? Math.min(100, (sp.maxMemMB / sp.memSizeMB) * 100) : null;
  return `<div class='space-y-3'>
    <div class='flex h-4 overflow-hidden rounded-full bg-base-300' role='img' aria-label='Trace timeline'>
      ${init > 0 ? `<div class='trace-segment bg-warning' style='width:${initPct.toFixed(1)}%' title='INIT ${fmt(init, 2)} ms'></div>` : ''}
      <div class='trace-segment bg-primary' style='width:${handlerPct.toFixed(1)}%' title='HANDLER ${fmt(handler, 2)} ms'></div>
    </div>
    <div class='grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4'>
      <div><div class='text-base-content/40'>INIT</div><div class='font-mono'>${init > 0 ? fmt(init, 2) + ' ms' : '<span class="text-base-content/40">warm</span>'}</div></div>
      <div><div class='text-base-content/40'>HANDLER</div><div class='font-mono'>${fmt(handler, 2)} ms</div></div>
      <div><div class='text-base-content/40'>BILLED</div><div class='font-mono'>${fmt(sp.billedMs)} ms</div></div>
      <div><div class='text-base-content/40'>MEMORY</div><div class='font-mono'>${sp.maxMemMB != null ? fmt(sp.maxMemMB) + ' / ' + fmt(sp.memSizeMB) + ' MB' : '—'}</div></div>
    </div>
    ${mem != null ? `<progress class='progress ${mem >= 95 ? 'progress-error' : 'progress-primary'} w-full' value='${sp.maxMemMB}' max='${sp.memSizeMB}'></progress>` : ''}
    <div class='flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-base-content/40'>
      <span>START ${esc(time(sp.start))}</span><span>END ${esc(time(sp.end))}</span><span>REPORT ${esc(time(sp.reportTs))}</span>
    </div>
  </div>`;
}

function spanLogs(sp) {
  const events = sp.events ?? [];
  if (!events.length) return `<div class='text-xs text-base-content/40'>No application log lines captured for this invocation.</div>`;
  return `<div class='log-pane max-h-64'>${events.map(e => `<div class='log-line ${isErrorLine(e.msg) ? 'log-line-error' : ''}'><span class='mr-2 text-base-content/40'>${esc(time(e.ts))}</span>${esc(e.msg)}</div>`).join('')}</div>`;
}

function renderTail(tail) {
  const el = document.getElementById('tail');
  if (!el) return;
  if (!tail.length) { el.innerHTML = `<span class='text-base-content/40' data-empty>No recent log lines.</span>`; return; }
  el.innerHTML = tail.slice(-100).map(e => `<div class='log-line ${isErrorLine(e.msg) ? 'log-line-error' : (isSystemLine(e.msg) ? 'log-line-system' : '')}'><span class='mr-2 text-base-content/40'>${esc(time(e.ts))}</span>${esc(e.msg)}</div>`).join('');
}

function renderLiveControls(running) {
  const badge = document.getElementById('live-badge');
  if (badge) {
    badge.className = 'badge badge-sm ' + (running ? 'badge-error' : 'badge-ghost');
    badge.textContent = running ? 'LIVE' : 'IDLE';
  }
  const start = document.querySelector('[data-live-start]');
  const stop = document.querySelector('[data-live-stop]');
  if (start) start.classList.toggle('hidden', running);
  if (stop) stop.classList.toggle('hidden', !running);
}

function startLive(fnName) {
  const fn = fnName || 'all';
  stopLive();
  const pane = document.getElementById('live-logs');
  if (pane) pane.innerHTML = '';
  if (typeof EventSource === 'undefined') {
    showError('This browser does not support server-sent events.');
    return;
  }
  renderLiveControls(true);
  const es = new EventSource('/api/logs/stream?fn=' + encodeURIComponent(fn));
  state.live = { es, fn, count: 0 };
  es.addEventListener('ready', () => {
    const badge = document.getElementById('live-badge');
    if (badge) { badge.className = 'badge badge-error badge-sm'; badge.textContent = 'LIVE'; }
  });
  es.addEventListener('log', ev => {
    try { appendLive(JSON.parse(ev.data)); } catch {}
  });
  es.addEventListener('error', ev => {
    if (!ev.data) return;
    try { showError(JSON.parse(ev.data).message); } catch {}
  });
  es.onerror = () => {
    if (state.live?.es !== es) return;
    const badge = document.getElementById('live-badge');
    if (badge) { badge.className = 'badge badge-warning badge-sm'; badge.textContent = 'RECONNECTING'; }
  };
}

function stopLive() {
  if (state.live?.es) state.live.es.close();
  state.live = null;
  renderLiveControls(false);
}

function appendLive(e) {
  const pane = document.getElementById('live-logs');
  if (!pane) return;
  if (pane.querySelector('[data-empty]')) pane.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'log-line ' + (isErrorLine(e.msg) ? 'log-line-error' : (isSystemLine(e.msg) ? 'log-line-system' : ''));
  const ts = document.createElement('span');
  ts.className = 'mr-2 text-base-content/40';
  ts.textContent = time(e.ts);
  const fn = document.createElement('span');
  fn.className = 'badge badge-ghost badge-xs mr-2';
  fn.textContent = shortFn(e.fn);
  const msg = document.createElement('span');
  msg.textContent = e.msg;
  line.append(ts, fn, msg);
  pane.appendChild(line);
  pane.scrollTop = pane.scrollHeight;
  if (state.live) state.live.count++;
}

function renderLive(params) {
  const d = state.data;
  const wanted = params.get('fn') ?? 'all';
  const selected = wanted === 'all' || d.lambdas.some(l => l.fnName === wanted) ? wanted : 'all';
  document.getElementById('page').innerHTML = `
    <div class='mb-6 flex flex-wrap items-end justify-between gap-4'>
      <div>
        <h1 class='text-2xl font-semibold tracking-tight'>Live tail</h1>
        <p class='mt-1 text-sm text-base-content/50'>CloudWatch Logs from ${d.lambdas.length} function${d.lambdas.length === 1 ? '' : 's'}, polled every 2 seconds.</p>
      </div>
      ${windowPicker()}
    </div>
    <div class='card border border-base-300 bg-base-100 shadow-sm'><div class='card-body gap-4'>
      <div class='flex flex-wrap items-end gap-3'>
        <label class='flex flex-col gap-1 text-xs text-base-content/50'>Function
          <select id='live-fn' class='select select-bordered select-sm'>
            <option value='all' ${selected === 'all' ? 'selected' : ''}>All functions</option>
            ${d.lambdas.map(l => `<option value='${esc(l.fnName)}' ${selected === l.fnName ? 'selected' : ''}>${esc(shortFn(l.fnName))}</option>`).join('')}
          </select>
        </label>
        <div class='ml-auto flex items-center gap-2'>
          <span id='live-badge' class='badge badge-ghost badge-sm'>IDLE</span>
          <button type='button' class='btn btn-primary btn-sm hidden' data-live-start='${esc(selected)}'>Start live</button>
          <button type='button' class='btn btn-ghost btn-sm' data-live-stop>Stop</button>
        </div>
      </div>
      <div id='live-logs' class='log-pane min-h-72'><span class='text-base-content/40' data-empty>Connecting…</span></div>
      <p class='text-xs text-base-content/40'>Only new events are shown. START/END/REPORT lines are dimmed; errors are highlighted.</p>
    </div></div>`;
  const select = document.getElementById('live-fn');
  if (select) {
    select.addEventListener('change', () => {
      location.hash = '#/live?fn=' + encodeURIComponent(select.value);
    });
  }
  startLive(selected);
}

async function renderExplorer(params, token) {
  const q = (params.get('q') ?? '').trim();
  const fn = params.get('fn') ?? 'all';
  const d = state.data;
  document.getElementById('page').innerHTML = `
    <div class='mb-6'>
      <h1 class='text-2xl font-semibold tracking-tight'>Explorer</h1>
      <p class='mt-1 text-sm text-base-content/50'>Search every function's CloudWatch logs by RequestId or text.</p>
    </div>
    <form id='explorer-form' class='card border border-base-300 bg-base-100 shadow-sm'>
      <div class='card-body gap-3'>
        <div class='flex flex-col gap-2 sm:flex-row'>
          <label class='input input-bordered flex flex-1 items-center gap-2'>
            <svg class='size-4 text-base-content/40' fill='none' viewBox='0 0 24 24' stroke='currentColor' stroke-width='1.8'><circle cx='11' cy='11' r='7'/><path stroke-linecap='round' d='m20 20-3.5-3.5'/></svg>
            <input name='q' class='grow' type='search' maxlength='256' required placeholder='RequestId or text…' value='${esc(q)}' autofocus>
          </label>
          <select name='fn' class='select select-bordered sm:w-64'>
            <option value='all' ${fn === 'all' ? 'selected' : ''}>All functions</option>
            ${d.lambdas.map(l => `<option value='${esc(l.fnName)}' ${fn === l.fnName ? 'selected' : ''}>${esc(shortFn(l.fnName))}</option>`).join('')}
          </select>
          <button class='btn btn-primary' type='submit'>Search</button>
        </div>
        <p class='text-xs text-base-content/50'>CloudWatch FilterLogEvents · ${WINDOW_LABEL[state.window]} · up to 100 matches.</p>
        <div id='explorer-error' class='alert alert-error hidden text-sm'></div>
      </div>
    </form>
    <div id='explorer-results' class='mt-6'></div>`;

  if (!q) {
    document.getElementById('explorer-results').innerHTML = emptyState('Search across all functions', 'Paste a RequestId from a REPORT line, or search for a message such as "Task timed out".');
    return;
  }
  document.getElementById('explorer-results').innerHTML = `<div class='flex items-center gap-2 text-sm text-base-content/50'><span class='loading loading-spinner loading-sm'></span> Searching CloudWatch Logs…</div>`;
  try {
    const data = await api('/api/explorer?q=' + encodeURIComponent(q) + '&fn=' + encodeURIComponent(fn) + '&window=' + state.window);
    if (token !== routeToken) return;
    renderExplorerResults(data, q);
  } catch (e) {
    if (token !== routeToken) return;
    document.getElementById('explorer-results').innerHTML = `<div class='alert alert-error text-sm'>${esc(e.message)}</div>`;
  }
}

function renderExplorerResults(data, q) {
  const el = document.getElementById('explorer-results');
  if (!el) return;
  const results = data.results ?? [];
  el.innerHTML = `<div class='card border border-base-300 bg-base-100 shadow-sm'><div class='card-body gap-3'>
    <div class='flex flex-wrap items-center gap-2'>
      <h2 class='card-title text-base'>Results</h2>
      <span class='badge badge-primary badge-sm'>${fmt(results.length)}</span>
      <span class='text-xs text-base-content/50'>for <code class='font-mono'>${esc(q)}</code> · ${esc(data.fn === 'all' ? 'all functions' : shortFn(data.fn))}</span>
      ${data.truncated ? `<span class='badge badge-warning badge-sm'>truncated</span>` : ''}
    </div>
    ${results.length ? `<div class='divide-y divide-base-300 rounded-box border border-base-300'>${results.map(e => `<div class='flex flex-col gap-1 p-3 sm:flex-row sm:gap-4'>
      <div class='flex shrink-0 items-center gap-2 sm:w-44'><span class='font-mono text-[11px] text-base-content/50'>${esc(dateTime(e.ts))}</span></div>
      <div class='min-w-0 flex-1'>
        <a class='badge badge-outline badge-sm mb-1 hover:badge-primary' href='#/fn/${encodeURIComponent(e.fn)}'>${esc(shortFn(e.fn))}</a>
        <div class='whitespace-pre-wrap break-words font-mono text-[11.5px]'>${highlight(e.msg, q)}</div>
      </div>
    </div>`).join('')}</div>` : emptyState('No matches', 'Try a shorter query or a wider window.')}
  </div></div>`;
}

function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const needle = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return safe.replace(new RegExp('(' + needle + ')', 'ig'), `<mark class='query-mark'>$1</mark>`); }
  catch { return safe; }
}

function shortFn(fn) {
  if (!fn) return '';
  const d = state.data;
  const prefix = d ? d.service + '-' + d.stage + '-' : '';
  return fn.startsWith(prefix) ? fn.slice(prefix.length) : fn;
}

function boot() {
  document.getElementById('refresh').addEventListener('click', () => loadService(true));
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  window.addEventListener('hashchange', () => { stopLive(); route(); });
  window.addEventListener('beforeunload', stopLive);
  loadService();
}

boot();
