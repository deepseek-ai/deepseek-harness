/**
 * Collects budgeted benchmark wall-clock endpoints and renders them as a self-contained interactive HTML
 * report that rescales each endpoint to the reviewed machine profiles.
 *
 * Bench files call {@link recordTimings} in the Vitest worker; the Vitest global setup of
 * `vitest.bench.config.ts` clears {@link REPORT_DIRECTORY} before the run and renders `report.html` after
 * it, including after failed cases.
 *
 * A scaled endpoint is `ms × ((1 − io) × cpuScore(measured) / cpuScore(target) × coreFactor + io ×
 * ioLatency(target) / ioLatency(measured))`. When the endpoint reports process CPU time, `io` is the measured
 * share of wall time not spent on CPU, `max(0, 1 − cpuMs / ms)`, and its busy parallelism is
 * `max(1, cpuMs / ms)`; otherwise `io` is a declared estimate and parallelism is 1. `coreFactor` is
 * `max(1, parallelism / cores(target)) / max(1, parallelism / cores(measured))`. Readers can override `io`
 * per endpoint. Memory and dimensionless ratios are not scaled.
 *
 * Bench files also pass peak memory to {@link recordPeakMemory}. The report compares those unscaled peaks
 * with 4 GB and 8 GB of available memory; it does not run cases under an operating-system memory limit.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
import { join } from 'node:path'
import { MACHINE_PROFILES, matchMachineProfile } from './machine-profiles.ts'

/** Directory owning `results.jsonl` and `report.html`; ignored by Git. */
export const REPORT_DIRECTORY = join(import.meta.dirname, '..', '.dsh-report')
const RESULTS_PATH = join(REPORT_DIRECTORY, 'results.jsonl')
const REPORT_PATH = join(REPORT_DIRECTORY, 'report.html')

/** Identity and reader-facing description of one benchmark case, shown when hovering its rows in the report. */
export interface BenchmarkCase {
  /** Case id, such as `session-open/first-open/phases`. */
  readonly id: string
  /** What the timed or sampled work is, including workload size. */
  readonly measures: string
  /** Which user-visible scenario the measurement represents. */
  readonly affects: string
}

/** Fields that every record copies from its {@link BenchmarkCase}. */
interface CaseFields {
  readonly benchmark: string
  readonly measures: string
  readonly affects: string
}

function caseFields(benchmarkCase: BenchmarkCase): CaseFields {
  return { benchmark: benchmarkCase.id, measures: benchmarkCase.measures, affects: benchmarkCase.affects }
}

/**
 * One endpoint: its wall-clock milliseconds and either the process CPU milliseconds measured over the same
 * interval or, where the worker cannot measure CPU time, a declared share from 0 to 1 of wall time spent
 * waiting on storage.
 */
export type Timing =
  | { readonly ms: number; readonly cpuMs: number }
  | { readonly ms: number; readonly ioShare: number }

/** One recorded wall-clock endpoint. */
export type TimingRecord = CaseFields & Timing & {
  readonly kind: 'time'
  readonly metric: string
  readonly budgetMs?: number
}

/**
 * Append measured endpoints of one benchmark case to the report results.
 * @param benchmarkCase - Case id and description.
 * @param timings - Endpoints keyed by name; record before asserting budgets.
 * @param budgetsMs - CI budgets keyed by the same endpoint names, where the case enforces one.
 */
export function recordTimings(
  benchmarkCase: BenchmarkCase,
  timings: Readonly<Record<string, Timing>>,
  budgetsMs: Readonly<Record<string, number>> = {},
): void {
  appendRecords(Object.entries(timings).map(([metric, timing]): TimingRecord => {
    const budgetMs = budgetsMs[metric]
    return { kind: 'time', ...caseFields(benchmarkCase), metric, ...timing, ...budgetMs === undefined ? {} : { budgetMs } }
  }))
}

/** One recorded peak memory measurement. */
export interface MemoryRecord extends CaseFields {
  readonly kind: 'memory'
  readonly metric: string
  readonly mb: number
}

/**
 * Append peak memory of one benchmark case to the report results.
 * @param benchmarkCase - Case id and description.
 * @param peaksMb - Peak megabytes keyed by measurement name, such as `peakRssMb`.
 */
export function recordPeakMemory(benchmarkCase: BenchmarkCase, peaksMb: Readonly<Record<string, number>>): void {
  appendRecords(Object.entries(peaksMb).map(([metric, mb]): MemoryRecord => ({ kind: 'memory', ...caseFields(benchmarkCase), metric, mb })))
}

function appendRecords(records: readonly (TimingRecord | MemoryRecord)[]): void {
  mkdirSync(REPORT_DIRECTORY, { recursive: true })
  appendFileSync(RESULTS_PATH, records.map(record => JSON.stringify(record) + '\n').join(''))
}

/** Vitest global setup: discard results of an earlier run. */
export function setup(): void {
  rmSync(REPORT_DIRECTORY, { recursive: true, force: true })
}

/** Vitest global teardown: render the report when any case recorded a timing. */
export function teardown(): void {
  if (!existsSync(RESULTS_PATH)) return
  const records = readFileSync(RESULTS_PATH, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as TimingRecord | MemoryRecord)
  const cpuModel = cpus()[0]?.model.trim() ?? 'unknown CPU'
  writeFileSync(REPORT_PATH, renderReport({
    records,
    cpuModel,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    revision: process.env['GITHUB_SHA'],
    generatedAt: new Date().toISOString(),
    cores: availableParallelism(),
    measuredProfile: matchMachineProfile(cpuModel),
  }))
  console.log(`benchmark report: ${REPORT_PATH}`)
}

/** Inputs embedded in one rendered report. */
export interface ReportData {
  readonly records: readonly (TimingRecord | MemoryRecord)[]
  readonly cpuModel: string
  readonly platform: string
  readonly node: string
  readonly revision: string | undefined
  readonly generatedAt: string
  /** Logical CPUs available to the measuring process; replaces the matched profile's core count. */
  readonly cores: number
  /** Profile id describing the measuring machine; the reader chooses one when absent. */
  readonly measuredProfile: string | undefined
}

/**
 * Render the self-contained report page.
 * @param data - Recorded endpoints and the measuring environment.
 * @returns HTML without external resources.
 */
export function renderReport(data: ReportData): string {
  const payload = JSON.stringify({ ...data, profiles: MACHINE_PROFILES }).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness benchmark scenarios</title>
<style>
body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #1f2328; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 28px 0 4px; }
.meta, .note { color: #59636e; margin: 4px 0; }
.controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; margin: 16px 0; }
select { font: inherit; max-width: 420px; }
svg text { font: 12px system-ui, sans-serif; fill: #1f2328; }
table { border-collapse: collapse; margin-top: 16px; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid #d1d9e0; padding: 3px 6px; text-align: right; white-space: nowrap; }
th { background: #f6f8fa; font-weight: 600; }
td:first-child, th:first-child { text-align: left; position: sticky; left: 0; background: #fff; }
tr.selected td:first-child { font-weight: 700; }
tbody tr { cursor: pointer; }
.wrap { overflow-x: auto; }
.b0 { background: #dafbe1; } .b1 { background: #fff8c5; } .b2 { background: #ffebe9; } .b3 { background: #ffcecb; }
.legend span { display: inline-block; padding: 0 6px; margin-right: 6px; }
</style>
</head>
<body>
<h1>DeepSeek Harness benchmark scenarios</h1>
<p class="meta" id="meta"></p>
<h2>Machines</h2>
<p class="note">Each measured endpoint is rescaled to other machines. Its CPU share scales by the PassMark single-thread rating ratio and slows further when the endpoint kept more CPUs busy than the target has. Its storage share scales by the typical 4 KiB queue-depth-1 latency ratio of the default disk. Endpoints that report process CPU time use their measured share of wall time not spent on CPU as the storage share; the others use a declared estimate. Profiles are estimates; memory size is not modelled.</p>
<div class="controls">
<label>Measured on <select id="measured"></select></label>
<label>Endpoint <select id="endpoint"></select></label>
<label>Storage-bound share <input id="io" type="range" min="0" max="1" step="0.01"> <output id="io-value"></output></label>
<button id="io-reset" type="button">Reset to default</button>
</div>
<p class="note" id="case"></p>
<svg id="chart" width="960" role="img" aria-label="Scaled endpoint per machine"></svg>
<p class="legend"><span class="b0">&lt; 100 ms</span><span class="b1">&lt; 1 s</span><span class="b2">&lt; 10 s</span><span class="b3">&ge; 10 s</span> Hover an endpoint for what it measures; click a row to chart it.</p>
<div class="wrap"><table id="table"></table></div>
<h2>Memory pressure</h2>
<p class="note">Measured peak memory of each case against 4 GB and 8 GB of memory available to DeepSeek Harness. Peaks are not scaled. Cases were not run under an operating-system memory limit, so swapping and reclaim costs are not measured.</p>
<svg id="memory-chart" width="960" role="img" aria-label="Peak memory against available memory"></svg>
<p class="legend"><span class="b0">&lt; 50%</span><span class="b1">&lt; 75%</span><span class="b2">&lt; 100%</span><span class="b3">&ge; 100%</span> of available memory</p>
<div class="wrap"><table id="memory-table"></table></div>
<script>
const data = ${payload};
const $ = id => document.getElementById(id);
const profiles = data.profiles;
const times = data.records.filter(r => r.kind === 'time');
const memories = data.records.filter(r => r.kind === 'memory');
const AVAILABLE_MB = [4096, 8192];
const keyOf = r => r.benchmark + ' · ' + r.metric;
const describe = r => 'Measures: ' + r.measures + '\\nAffects: ' + r.affects;
const defaultShare = r => r.cpuMs === undefined ? r.ioShare : Math.min(1, Math.max(0, 1 - r.cpuMs / r.ms));
const shareSource = r => r.cpuMs === undefined ? 'declared' : 'measured';
const parallelism = r => r.cpuMs === undefined ? 1 : Math.max(1, r.cpuMs / r.ms);
const pct = share => (share < 0.1 && share > 0 ? (share * 100).toFixed(1) : Math.round(share * 100)) + '%';
const ioShares = times.map(defaultShare);
let selected = 0;
const fmt = ms => ms >= 10000 ? (ms / 1000).toFixed(0) + ' s' : ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms >= 10 ? ms.toFixed(0) + ' ms' : ms.toFixed(1) + ' ms';
const fmtMb = mb => mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(0) + ' MB';
const band = ms => ms < 100 ? 0 : ms < 1000 ? 1 : ms < 10000 ? 2 : 3;
const memoryBand = share => share < 0.5 ? 0 : share < 0.75 ? 1 : share < 1 ? 2 : 3;
const colors = ['#1a7f37', '#9a6700', '#cf222e', '#82071e'];
function scale(index, target) {
  const record = times[index];
  const base = profiles.find(p => p.id === $('measured').value);
  const io = ioShares[index];
  const busy = parallelism(record);
  const baseCores = base.id === data.measuredProfile ? data.cores : base.cores;
  const coreFactor = Math.max(1, busy / target.cores) / Math.max(1, busy / baseCores);
  return record.ms * ((1 - io) * base.cpuScore / target.cpuScore * coreFactor + io * target.ioLatencyUs / base.ioLatencyUs);
}
function esc(text) { const node = document.createElement('span'); node.textContent = text; return node.innerHTML.replaceAll('"', '&quot;'); }
/** Draws one horizontal bar per row on a logarithmic axis with labelled vertical ticks. */
function bars(svg, rows, ticks, format) {
  const left = 380, width = 500, rowH = 22, top = 24;
  const values = rows.map(r => r.value).concat(ticks.filter(t => t.marked).map(t => t.value));
  const min = Math.min(...values) / 2, max = Math.max(...values) * 2;
  const x = value => left + width * Math.log(value / min) / Math.log(max / min);
  let html = '';
  for (const t of ticks) {
    if (t.value < min || t.value > max) continue;
    html += '<line x1="' + x(t.value) + '" x2="' + x(t.value) + '" y1="' + (top - 6) + '" y2="' + (top + rows.length * rowH) + '" stroke="' + (t.marked ? '#59636e' : '#d1d9e0') + '"' + (t.marked ? ' stroke-dasharray="4 3"' : '') + '/><text x="' + x(t.value) + '" y="' + (top - 10) + '" text-anchor="middle">' + esc(t.label) + '</text>';
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    html += '<text x="' + (left - 8) + '" y="' + (y + 15) + '" text-anchor="end">' + esc(r.label) + '</text>';
    html += '<rect x="' + left + '" y="' + (y + 3) + '" width="' + Math.max(1, x(r.value) - left) + '" height="' + (rowH - 6) + '" fill="' + colors[r.band] + '"' + (r.current ? ' stroke="#1f2328" stroke-width="2"' : '') + '><title>' + esc(r.title) + '</title></rect>';
    html += '<text x="' + (x(r.value) + 6) + '" y="' + (y + 15) + '">' + format(r.value) + '</text>';
  });
  svg.setAttribute('height', String(top + rows.length * rowH + 8));
  svg.innerHTML = html;
}
$('meta').textContent = 'Measured on ' + data.cpuModel + ' with ' + data.cores + ' available CPUs (' + data.platform + ', Node ' + data.node + ')' + (data.revision ? ', revision ' + data.revision.slice(0, 12) : '') + ', ' + data.generatedAt + '.';
const machine = p => p.cpu + ', ' + p.cores + ' CPUs, ' + p.storage;
for (const p of profiles) $('measured').add(new Option(p.label + ' — ' + machine(p), p.id));
$('measured').value = data.measuredProfile ?? 'github-ubuntu-24.04';
if (!data.measuredProfile) $('meta').textContent += ' No profile matches this CPU; choose the closest one.';
times.forEach((r, i) => $('endpoint').add(new Option(keyOf(r), String(i))));
function table() {
  let html = '<thead><tr><th>Endpoint</th><th>Measured</th><th>CI budget</th><th title="Default storage-bound share and its source">Storage share</th><th title="Average CPUs kept busy, from process CPU time">CPUs busy</th>' + profiles.map(p => '<th title="' + esc(machine(p)) + '">' + esc(p.label) + '</th>').join('') + '</tr></thead><tbody>';
  times.forEach((r, i) => {
    html += '<tr data-index="' + i + '"' + (i === selected ? ' class="selected"' : '') + '><td title="' + esc(describe(r)) + '">' + esc(keyOf(r)) + '</td><td>' + fmt(r.ms) + '</td><td>' + (r.budgetMs === undefined ? '' : fmt(r.budgetMs)) + '</td><td>' + pct(ioShares[i]) + ' ' + (ioShares[i] === defaultShare(r) ? shareSource(r) : 'override') + '</td><td>' + (r.cpuMs === undefined ? '' : parallelism(r).toFixed(2)) + '</td>';
    for (const p of profiles) { const ms = scale(i, p); html += '<td class="b' + band(ms) + '">' + fmt(ms) + '</td>'; }
    html += '</tr>';
  });
  $('table').innerHTML = html + '</tbody>';
}
function render() {
  if (times.length === 0) return;
  $('endpoint').value = String(selected);
  $('io').value = String(ioShares[selected]);
  $('io-value').textContent = pct(ioShares[selected]) + ' (default ' + pct(defaultShare(times[selected])) + ' ' + shareSource(times[selected]) + ')';
  $('case').textContent = describe(times[selected]).replace('\\n', ' ');
  bars($('chart'), profiles.map(p => {
    const ms = scale(selected, p);
    return { label: p.label + ' · ' + p.storage, title: machine(p), value: ms, band: band(ms), current: p.id === $('measured').value };
  }), [1, 10, 100, 1000, 10000, 100000, 1000000].map(value => ({ value, label: fmt(value), marked: value === 100 || value === 1000 })), fmt);
  table();
}
function renderMemory() {
  if (memories.length === 0) return;
  bars($('memory-chart'), memories.map(r => ({ label: keyOf(r), title: describe(r), value: r.mb, band: memoryBand(r.mb / AVAILABLE_MB[0]), current: false })),
    [16, 64, 256, 1024].map(value => ({ value, label: fmtMb(value), marked: false })).concat(AVAILABLE_MB.map(value => ({ value, label: fmtMb(value) + ' available', marked: true }))), fmtMb);
  let html = '<thead><tr><th>Case</th><th>Peak</th>' + AVAILABLE_MB.map(mb => '<th>' + fmtMb(mb) + ' available</th>').join('') + '</tr></thead><tbody>';
  for (const r of memories) {
    html += '<tr><td title="' + esc(describe(r)) + '">' + esc(keyOf(r)) + '</td><td>' + fmtMb(r.mb) + '</td>';
    for (const mb of AVAILABLE_MB) html += '<td class="b' + memoryBand(r.mb / mb) + '">' + Math.round(100 * r.mb / mb) + '%</td>';
    html += '</tr>';
  }
  $('memory-table').innerHTML = html + '</tbody>';
}
$('measured').onchange = render;
$('endpoint').onchange = () => { selected = Number($('endpoint').value); render(); };
$('io').oninput = () => { ioShares[selected] = Number($('io').value); render(); };
$('io-reset').onclick = () => { ioShares[selected] = defaultShare(times[selected]); render(); };
$('table').onclick = event => { const row = event.target.closest('tr[data-index]'); if (row) { selected = Number(row.dataset.index); render(); } };
render();
renderMemory();
</script>
</body>
</html>
`
}
