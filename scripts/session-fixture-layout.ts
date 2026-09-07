/** Canonical packed-row and envelope projection helpers for repository session fixtures. */

import { deepStrictEqual } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decodeSeqRanges,
  SessionLogOffset,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

/** Physical persistence artifacts validated by the WebWorker runtime fixture spec. */
const WEBWORKER_PHYSICAL_SESSION_FIXTURE_ROOT =
  'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/'

/** Installed-runtime snapshots that preserve the JSONL writer's physical encoding. */
const PYTHON_RUNTIME_PHYSICAL_SESSION_FIXTURE_ROOT =
  'scripts/snapshots/python-sdk-single-exe/'

/** One repository session fixture and its canonical projected representation. */
export interface SessionFixtureLayout {
  /** Repository-relative path with `/` separators. */
  path: string
  /** Current fixture bytes decoded as UTF-8. */
  source: string
  /** Canonical projected fixture bytes. */
  canonical: string
}

/**
 * Whether a repository JSONL preserves physical persistence encoding rather
 * than the logical event projection owned by this script.
 * @param path - Repository-relative path with `/` separators.
 * @returns True for physical WebWorker and installed-runtime session logs.
 */
export function isPhysicalSessionFixture(path: string): boolean {
  if (path.startsWith(WEBWORKER_PHYSICAL_SESSION_FIXTURE_ROOT)) {
    return /\/session(?:\.v[1-9]\d*)?\.jsonl$/.test(path)
  }
  return path.startsWith(PYTHON_RUNTIME_PHYSICAL_SESSION_FIXTURE_ROOT)
    && /\/session(?:\.[1-9]\d*)?(?:\.v[1-9]\d*)?\.jsonl$/.test(path)
}

function isSessionHeader(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'session'
}

function validationHeader(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const header = { ...value as Record<string, unknown> }
  if (header.version === 0 && !Object.hasOwn(header, 'delegationDepth')) header.delegationDepth = 0
  if (typeof header.cwd === 'string' && /^\{\{cwd\}\}(?:\/|$)/.test(header.cwd)) {
    header.cwd = header.cwd.replace('{{cwd}}', '/dsh-snapshot-cwd')
  }
  return header
}

function validationRow(source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (source.type !== 'request/header') return { ...source }
  const data = source.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ...source }
  const header = (data as Record<string, unknown>).header
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return { ...source }
  if ((header as Record<string, unknown>).tools !== '{{tools}}') return { ...source }
  return {
    ...source,
    data: {
      ...data,
      header: { ...header, tools: [] },
    },
  }
}

function restoreRequestHeaderTokens(
  events: readonly SessionEvent[],
  rows: readonly Readonly<Record<string, unknown>>[],
): SessionEvent[] {
  const sources = rows.filter(row => row.type === 'request/header')
  let sourceIndex = 0
  return events.map((event) => {
    if (event.type !== 'request/header') return event
    const source = sources[sourceIndex]
    sourceIndex += 1
    const sourceData = source?.data
    const sourceHeader = sourceData !== null && typeof sourceData === 'object' && !Array.isArray(sourceData)
      ? (sourceData as Record<string, unknown>).header
      : undefined
    if (sourceHeader === null || typeof sourceHeader !== 'object' || Array.isArray(sourceHeader)
      || (sourceHeader as Record<string, unknown>).tools !== '{{tools}}') return event
    return {
      ...event,
      data: {
        ...event.data,
        header: {
          ...(event.data as unknown as { header: Record<string, unknown> }).header,
          tools: '{{tools}}',
        },
      },
    } as SessionEvent
  })
}

function renderFixture(headerLine: string, events: readonly SessionEvent[]): string {
  return [
    headerLine,
    ...events.map((event) => {
      const record = { ...event } as unknown as Record<string, unknown>
      delete record.seq
      delete record.time
      return JSON.stringify(record)
    }),
    '',
  ].join('\n')
}

function projectedRowCardinality(record: Readonly<Record<string, unknown>>): number {
  const data = record.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 1
  const key = record.type === 'tool-call-chunks' ? 'args' : 'texts'
  const values = (data as Record<string, unknown>)[key]
  return Array.isArray(values) && values.length > 0 ? values.length : 1
}

function parseFixtureObjectLine(line: string, lineNumber: number): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch (error) {
    throw new Error(`session snapshot line ${lineNumber} contains invalid JSON`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`session snapshot line ${lineNumber} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function parseFixtureRows(content: string, headerValue: unknown): SessionEvent[] {
  const rows: Record<string, unknown>[] = []
  const rowLines: number[] = []
  const eventLines: number[] = []
  let nextSeq: SessionLogOffsetType = SessionLogOffset(0)
  let headerSkipped = false
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    if (!headerSkipped) {
      headerSkipped = true
      continue
    }
    const record = parseFixtureObjectLine(line, index + 1)
    const packed = record.type === 'text-chunks'
      || record.type === 'reasoning-chunks'
      || record.type === 'tool-call-chunks'
    const seqKey = packed ? 'seq0' : 'seq'
    const timeKey = packed ? 'time0' : 'time'
    if (!Object.hasOwn(record, seqKey)) record[seqKey] = nextSeq
    if (!Object.hasOwn(record, timeKey)) record[timeKey] = 0
    rows.push(record)
    rowLines.push(index + 1)
    const cardinality = projectedRowCardinality(record)
    for (let offset = 0; offset < cardinality; offset += 1) eventLines.push(index + 1)
    nextSeq = SessionLogOffset(nextSeq + cardinality)
  }
  // Versionless protocol fixtures and current projected snapshots use scalar
  // event rows. Current snapshots may contain owner-restored scrub tokens such
  // as `{{tools}}`; semantic replay restores those sidecars, while this layout
  // gate owns only envelopes, provenance ranges, and one-event-per-row form.
  const projectedCurrent = headerValue !== null
    && typeof headerValue === 'object'
    && !Array.isArray(headerValue)
    && (headerValue as Record<string, unknown>).version === sessionFormatCatalog.currentVersion
  if (headerValue === null || typeof headerValue !== 'object' || Array.isArray(headerValue)
    || !Object.hasOwn(headerValue, 'version') || projectedCurrent) {
    return rows.map((source, index) => {
      const record = { ...source }
      try {
        if (record.type === 'text-chunks'
          || record.type === 'reasoning-chunks'
          || record.type === 'tool-call-chunks') {
          throw new Error('current projected fixtures cannot contain legacy packed rows')
        }
        if (Object.hasOwn(record, 'sourceEventSeqs')) {
          record.sourceEventSeqs = decodeSeqRanges(record.sourceEventSeqs)
        }
        return record as unknown as SessionEvent
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`session snapshot line ${rowLines[index] ?? 1}: ${detail}`, { cause: error })
      }
    })
  }
  let restore: ReturnType<typeof sessionFormatCatalog.createRestore>
  try {
    restore = sessionFormatCatalog.createRestore(validationHeader(headerValue), {
      recovery: 'strict',
      validation: 'current',
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`session snapshot line 1: ${detail}`, { cause: error })
  }
  for (const [index, row] of rows.entries()) {
    try {
      restore.decodeRow(validationRow(row))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`session snapshot line ${rowLines[index] ?? 1}: ${detail}`, { cause: error })
    }
  }
  try {
    return restoreRequestHeaderTokens(
      [...restore.finish().events] as unknown as SessionEvent[],
      rows,
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const line = fixtureDiagnosticLine(error, rowLines, eventLines)
    throw new Error(`session snapshot line ${line}: ${detail}`, { cause: error })
  }
}

function fixtureDiagnosticLine(
  error: unknown,
  rowLines: readonly number[],
  eventLines: readonly number[],
): number {
  const detail = error instanceof Error && error.cause instanceof Error
    ? error.cause.message
    : error instanceof Error ? error.message : String(error)
  const physicalRow = /^released Session row (\d+)/.exec(detail)
  if (physicalRow !== null) return rowLines[Number(physicalRow[1])] ?? 1
  const event = /Session event (\d+)/.exec(detail)
    ?? / at seq (\d+)/.exec(detail)
    ?? /inherited Session cut (\d+)/.exec(detail)
  return event === null ? 1 : eventLines[Number(event[1])] ?? 1
}

function withoutEnvelope(events: readonly SessionEvent[]): Array<Omit<SessionEvent, 'seq' | 'time'>> {
  return events.map((event) => {
    const { seq: _seq, time: _time, ...projected } = event
    return projected
  })
}

/**
 * Canonicalize one JSONL document when its first record is a session header.
 * The header line remains byte-identical; body records decode to logical events,
 * re-encode one event per row, and omit storage sequence/time envelopes.
 * Non-session JSONL returns undefined.
 *
 * @param content - JSONL source text.
 * @param label - path-like diagnostic label.
 * @returns Canonical text for a session fixture, otherwise undefined.
 */
export function canonicalSessionFixture(content: string, label = '<session-fixture>'): string | undefined {
  const headerLine = content.split(/\r?\n/).find(line => line.trim().length > 0)
  if (headerLine === undefined) return undefined

  let headerValue: unknown
  try {
    headerValue = JSON.parse(headerLine) as unknown
  } catch {
    return undefined
  }
  if (!isSessionHeader(headerValue)) return undefined

  let events
  try {
    events = parseFixtureRows(content, headerValue)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: ${detail}`, { cause: error })
  }
  const storedVersion = headerValue !== null
    && typeof headerValue === 'object'
    && !Array.isArray(headerValue)
    && typeof (headerValue as Record<string, unknown>).version === 'number'
    ? (headerValue as Record<string, number>).version
    : undefined
  // Released predecessor generations are immutable compatibility fixtures.
  // Parsing above still validates their physical rows, but canonicalization
  // never rewrites their committed bytes into the current scalar layout.
  if (storedVersion !== undefined && storedVersion < sessionFormatCatalog.currentVersion) {
    return content
  }
  const canonical = renderFixture(headerLine, events)
  const decoded = parseFixtureRows(canonical, headerValue)
  try {
    deepStrictEqual(withoutEnvelope(decoded), withoutEnvelope(events))
  } catch (error) {
    throw new Error(`${label}: packed snapshot rewrite changed the event payload stream`, { cause: error })
  }
  if (renderFixture(headerLine, decoded) !== canonical) {
    throw new Error(`${label}: packed rewrite is not idempotent`)
  }
  return canonical
}

/**
 * Discover tracked and unignored untracked JSONL files through Git.
 *
 * @param root - repository root.
 * @returns Stable repository-relative paths.
 */
function discoverJsonlFiles(root: string): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.jsonl'],
    { cwd: root, encoding: 'utf8' },
  ).split('\0')
    .filter(path => path.length > 0 && existsSync(resolve(root, path)))
    .sort()
}

/**
 * Inspect every repository JSONL whose first record is a session header.
 *
 * @param root - repository root.
 * @returns Session fixtures with current and canonical text.
 */
export function inspectSessionFixtureLayouts(root: string): SessionFixtureLayout[] {
  return discoverJsonlFiles(root).flatMap((path) => {
    if (isPhysicalSessionFixture(path)) return []
    const source = readFileSync(resolve(root, path), 'utf8')
    const canonical = canonicalSessionFixture(source, path)
    return canonical === undefined ? [] : [{ path, source, canonical }]
  })
}
