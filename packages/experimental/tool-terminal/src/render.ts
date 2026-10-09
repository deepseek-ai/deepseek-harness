/** Model and UI rendering for persistent terminal tool results. */

import { TextRetainer } from '@deepseek-ai/dsh-output-retention'

interface RenderedSessionStatusRunning {
  kind: 'running'
}

interface RenderedSessionStatusExited {
  kind: 'exited'
  exitCode: number | null
  signal: string | null
}

type RenderedSessionStatus = RenderedSessionStatusRunning | RenderedSessionStatusExited

interface RenderedSessionSnapshot {
  sessionId: string
  name?: string
  type: string
  pid?: number
  status: RenderedSessionStatus
}

interface RenderedSpawnResult extends RenderedSessionSnapshot {
  motd: string
}

interface RenderedSendResult {
  viewport: string
  waitReason: 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit'
  sessionStatus: RenderedSessionStatus
  truncated: boolean
}

interface RenderedSendRead {
  delta: string
  truncated: boolean
}

interface RenderedReadResult {
  text: string
  totalLines: number
  lineBegin: number
  lineEnd: number
  truncated: boolean
}

const encoder = new TextEncoder()
const TRUNCATED = '\n[output truncated]'

function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

function retain(text: string, maxBytes: number, kind: 'head' | 'tail'): string {
  const retainer = new TextRetainer({ kind, maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function fitWithSuffix(content: string, suffix: string, maxBytes: number): string {
  const fixedBytes = byteLength(suffix)
  if (fixedBytes >= maxBytes) return retain(suffix, maxBytes, 'tail')
  return `${retain(content, maxBytes - fixedBytes, 'tail')}${suffix}`
}

function fitWithPrefix(prefix: string, content: string, maxBytes: number): string {
  const fixed = `${prefix}${TRUNCATED}`
  const fixedBytes = byteLength(fixed)
  if (fixedBytes >= maxBytes) return retain(fixed, maxBytes, 'head')
  return `${prefix}${retain(content, maxBytes - fixedBytes, 'tail')}${TRUNCATED}`
}

function boundBodyWithSuffix(
  content: string,
  metadata: string,
  upstreamTruncated: boolean,
  maxBytes: number,
): string {
  const suffix = `${metadata}${upstreamTruncated ? TRUNCATED : ''}`
  const complete = `${content}${suffix}`
  if (byteLength(complete) <= maxBytes) return complete
  return fitWithSuffix(content, `${metadata}${TRUNCATED}`, maxBytes)
}

/**
 * Bound one complete terminal acknowledgement while preserving UTF-8 cuts.
 * @param text - complete acknowledgement text.
 * @param maxBytes - positive final result cap.
 * @returns bounded text with a truncation marker when it fits.
 */
export function boundTerminalText(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  const markerBytes = byteLength(TRUNCATED)
  if (markerBytes >= maxBytes) return retain(TRUNCATED, maxBytes, 'tail')
  return `${retain(text, maxBytes - markerBytes, 'head')}${TRUNCATED}`
}

/**
 * Render one created session and its bounded MOTD.
 * @param result - published spawn result.
 * @param maxBytes - complete UTF-8 result cap.
 * @returns Model-facing session acknowledgement.
 */
export function renderSpawn(result: RenderedSpawnResult, maxBytes: number): string {
  const label = result.name === undefined ? result.sessionId : `${result.sessionId} (${result.name})`
  const prefix = `started terminal session ${label} [type: ${result.type}]\n`
  const motd = result.motd || '(no startup output)'
  const complete = `${prefix}${motd}`
  return byteLength(complete) <= maxBytes ? complete : fitWithPrefix(prefix, motd, maxBytes)
}

/**
 * Render one settled interactive send.
 * @param result - settled send outcome.
 * @param maxBytes - complete UTF-8 result cap.
 * @returns Terminal output plus wait/session markers.
 */
export function renderSend(result: RenderedSendResult, maxBytes: number): string {
  const output = result.viewport || '(no new output)'
  const status = result.sessionStatus.kind === 'running'
    ? 'running'
    : `exited code=${result.sessionStatus.exitCode ?? 'null'} signal=${result.sessionStatus.signal ?? 'null'}`
  return boundBodyWithSuffix(
    output,
    `\n[wait: ${result.waitReason}]\n[session: ${status}]`,
    result.truncated,
    maxBytes,
  )
}

/**
 * Render one incremental background operation read.
 * @param read - consuming operation delta.
 * @returns Delta plus its upstream truncation marker. The generic task control
 *   applies the producer's complete-result cap after adding job status.
 */
export function renderSendRead(read: RenderedSendRead): string {
  const separator = read.delta.endsWith('\n') || read.delta.length === 0 ? '' : '\n'
  return `${read.delta}${read.truncated ? `${separator}[output truncated]` : ''}`
}

/**
 * Render one bounded historical page.
 * @param result - retained scrollback page.
 * @param maxBytes - complete UTF-8 result cap.
 * @returns Page text plus pagination and truncation markers.
 */
export function renderRead(result: RenderedReadResult, maxBytes: number): string {
  const output = result.text || '(no retained output)'
  return boundBodyWithSuffix(
    output,
    `\n[lines: ${result.lineBegin}-${result.lineEnd} of ${result.totalLines}]`,
    result.truncated,
    maxBytes,
  )
}

/**
 * Render owner-visible live sessions.
 * @param sessions - fresh owner-scoped snapshots.
 * @param maxBytes - complete UTF-8 result cap.
 * @returns One line per session or the empty marker.
 */
export function renderList(sessions: readonly RenderedSessionSnapshot[], maxBytes: number): string {
  if (sessions.length === 0) return '(no terminal sessions)'
  const text = sessions.map((session) => {
    const name = session.name === undefined ? '' : ` (${session.name})`
    const pid = session.pid === undefined ? '' : ` pid=${session.pid}`
    const status = session.status.kind === 'running'
      ? 'running'
      : `exited code=${session.status.exitCode ?? 'null'} signal=${session.status.signal ?? 'null'}`
    return `${session.sessionId}${name} [${session.type}] ${status}${pid}`
  }).join('\n')
  return boundBodyWithSuffix(text, '', false, maxBytes)
}
