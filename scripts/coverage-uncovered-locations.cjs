'use strict';

/**
 * Istanbul coverage reporter printing one clickable `path:line:col` record per
 * uncovered statement, branch path, and function. Vitest's per-file threshold
 * failures name only the file; this reporter supplies the exact locations,
 * printed just above those ERROR lines (reports run before threshold checks).
 * Files at 100% print nothing, so a green run stays silent.
 *
 * CommonJS by requirement: istanbul-reports loads custom reporters with a bare
 * require() outside the tsx/ESM pipeline (istanbul-reports index.js create()),
 * so this file can be neither TypeScript nor ESM. Wired into vitest.config.ts
 * by absolute path — require() would resolve a relative specifier against
 * istanbul-reports' own directory.
 */

const path = require('node:path');
const { ReportBase } = require('istanbul-lib-report');

/**
 * End column of a location that spans to the end of its start line. Whole-line
 * statements carry `Infinity` until a partition blob serializes it, which the
 * partition reporter replaces with this finite column
 * (scripts/coverage-canonical-locations.ts); both spellings read as line ends.
 */
const END_OF_LINE_COLUMN = Number.MAX_SAFE_INTEGER;

/**
 * Editor-convention `line:column` of an istanbul location start (istanbul
 * columns are 0-based; editors and terminal link handlers expect 1-based).
 */
function pos(loc) {
  return `${loc.start.line}:${loc.start.column + 1}`;
}

/** Whether a location carries a usable 1-based start line. */
function usable(loc) {
  return Boolean(loc && loc.start && Number.isFinite(loc.start.line) && loc.start.line >= 1);
}

/** Whether an end column marks its line's end instead of a measured position. */
function atLineEnd(column) {
  return !Number.isFinite(column) || column >= END_OF_LINE_COLUMN;
}

/**
 * ` (to line:col)` suffix when the range end adds information beyond the
 * start. v8-remapped whole-line statements end at their line end; those
 * degrade to a line-only suffix, or to nothing on a single line.
 */
function endSuffix(loc) {
  const end = loc.end;
  if (!end || !Number.isFinite(end.line) || end.line < 1) return '';
  if (atLineEnd(end.column)) {
    return end.line === loc.start.line ? '' : ` (to ${end.line})`;
  }
  if (end.line === loc.start.line && end.column === loc.start.column) return '';
  return ` (to ${end.line}:${end.column + 1})`;
}

class UncoveredLocationsReport extends ReportBase {
  constructor(opts = {}) {
    super(opts);
    // Vitest passes the resolved config root alongside reporter options.
    this.projectRoot = opts.projectRoot || process.cwd();
    this.records = [];
  }

  onStart() {
    this.records = [];
  }

  onDetail(node) {
    const fc = node.getFileCoverage();
    const rel = path.relative(this.projectRoot, fc.path).split(path.sep).join('/');
    const items = [];
    const add = (loc, text) => items.push({ line: loc.start.line, column: loc.start.column, text });

    for (const id of Object.keys(fc.statementMap)) {
      if (fc.s[id] !== 0) continue;
      const loc = fc.statementMap[id];
      if (!usable(loc)) continue;
      add(loc, `${rel}:${pos(loc)} uncovered statement${endSuffix(loc)}`);
    }

    for (const id of Object.keys(fc.fnMap)) {
      if (fc.f[id] !== 0) continue;
      const fn = fc.fnMap[id];
      const loc = usable(fn.decl) ? fn.decl : fn.loc;
      if (!usable(loc)) continue;
      const name = fn.name ? ` ${fn.name}` : '';
      add(loc, `${rel}:${pos(loc)} uncovered function${name}`);
    }

    for (const id of Object.keys(fc.branchMap)) {
      const counts = fc.b[id];
      const branch = fc.branchMap[id];
      for (let i = 0; i < counts.length; i += 1) {
        if (counts[i] !== 0) continue;
        // Implicit arms (e.g. a missing else) may carry an empty location;
        // fall back to the branch's own span so the record stays clickable.
        const loc = usable(branch.locations && branch.locations[i]) ? branch.locations[i] : branch.loc;
        if (!usable(loc)) continue;
        add(loc, `${rel}:${pos(loc)} uncovered branch (${branch.type}, path ${i + 1}/${counts.length})`);
      }
    }

    if (items.length === 0) return;
    items.sort((a, b) => a.line - b.line || a.column - b.column);
    for (const item of items) this.records.push(item.text);
  }

  onEnd() {
    if (this.records.length === 0) return;
    console.log(`\nUncovered locations (per-file 100% gate): ${this.records.length}`);
    for (const record of this.records) console.log(record);
    console.log('');
  }
}

module.exports = UncoveredLocationsReport;
