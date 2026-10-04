/**
 * Per-send readiness timeline for the persistent pwsh Loader-composition case: every
 * decoded pty chunk as the session's sanitizer saw it, every foreground poll result,
 * every input write, and how each send settled, formatted for a failure message so a
 * lost controlled-prompt fast path names the state that lost it.
 */
import type { SubprocessTerminalForeground, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type { TerminalSendOperation, TerminalSendRequest, TerminalWaitReason } from '@deepseek-ai/dsh-terminal'
import { CONTROLLED_PROMPT, TerminalSanitizer } from '@deepseek-ai/dsh-terminal-bash/src/sanitize.ts'
import type { SanitizedChunk } from '@deepseek-ai/dsh-terminal-bash/src/sanitize.ts'
import { vi } from 'vitest'

/** First line of the formatted timeline; a failure message carrying it needs no second print. */
export const TIMELINE_HEADER = 'readiness timeline (ms since the case started; s<n> = terminal session in spawn order)'

interface ChunkEvent {
  kind: 'chunk'
  seq: number
  at: number
  session: number
  units: number
  sample: string
  prompt: boolean
  promptTail: string | undefined
  textLength: number
}

interface PollEvent {
  kind: 'poll'
  seq: number
  at: number
  session: number
  foreground: string
}

interface WriteEvent {
  kind: 'write'
  seq: number
  at: number
  session: number
  units: number
  /** Whether the bytes are the tracked send's own input; other writes are terminal-protocol replies. */
  input: boolean
}

interface SpawnEvent {
  kind: 'spawn'
  seq: number
  at: number
  session: number
  pid: number
}

type TimelineEvent = ChunkEvent | PollEvent | WriteEvent | SpawnEvent

/** An event before the timeline stamps its sequence number and time. */
type RecordedEvent = {
  [K in TimelineEvent['kind']]: Omit<Extract<TimelineEvent, { kind: K }>, 'seq' | 'at'>
}[TimelineEvent['kind']]

interface SendWindow {
  label: string
  /** The exact bytes the session writes for this send; a matching write is the evidence reset. */
  input: string
  startedAt: number
  startSeq: number
  settledAt: number | undefined
  endSeq: number | undefined
  outcome: TerminalWaitReason | 'rejected' | 'pending'
}

/** Replayed prompt evidence for one send window. */
export interface PromptEvidence {
  promptSeen: boolean
  promptTail: string
  promptTextSeen: boolean
}

/** A chunk as the replay needs it: the sanitizer's verdict for one decoded pty chunk. */
export interface ReplayChunk {
  prompt: boolean
  promptTail: string | undefined
}

const SAMPLE_UNITS = 100
const SHOWN_HEAD_CHUNKS = 2
const SHOWN_TAIL_CHUNKS = 6

function escapeControl(text: string): string {
  return text.replace(/[\\\x00-\x1f\x7f]/g, (char) => {
    switch (char) {
      case '\\': return '\\\\'
      case '\n': return '\\n'
      case '\r': return '\\r'
      case '\x1b': return '\\e'
      default: return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    }
  })
}

function sample(text: string): string {
  if (text.length <= 2 * SAMPLE_UNITS) return escapeControl(text)
  return `${escapeControl(text.slice(0, SAMPLE_UNITS))}…(+${text.length - 2 * SAMPLE_UNITS} units)…${escapeControl(text.slice(-SAMPLE_UNITS))}`
}

const TAIL_UNITS = 24

/** Quote an already-escaped sample. */
function quoted(escaped: string): string {
  return `"${escaped}"`
}

/** The session keeps at most one unit past the controlled prompt, so a short prefix names the tail. */
function tail(text: string | undefined): string {
  if (text === undefined) return '-'
  if (text.length <= TAIL_UNITS) return quoted(escapeControl(text))
  return `"${escapeControl(text.slice(0, TAIL_UNITS))}…(+${text.length - TAIL_UNITS} units)"`
}

/**
 * The session's own prompt-tail rule replayed over one window's chunks: a marker starts an
 * empty tail, later printable text extends it up to one unit past the controlled prompt, and
 * the exact prompt text is the fast-path evidence. Mirrors `LocalPtySession.onData`.
 * @param chunks - the sanitizer verdicts since the send's input write, in delivery order.
 * @returns The evidence the session holds after the last chunk.
 */
export function replayPromptEvidence(chunks: readonly ReplayChunk[]): PromptEvidence {
  let promptSeen = false
  let promptTail = ''
  for (const chunk of chunks) {
    if (chunk.prompt) {
      promptSeen = true
      promptTail = ''
    }
    if (promptSeen && chunk.promptTail !== undefined) {
      const remaining = Math.max(0, CONTROLLED_PROMPT.length + 1 - promptTail.length)
      promptTail += chunk.promptTail.slice(0, remaining)
      if (chunk.promptTail.length > remaining) promptTail = `${CONTROLLED_PROMPT}\0`
    }
  }
  return { promptSeen, promptTail, promptTextSeen: promptTail === CONTROLLED_PROMPT }
}

/**
 * Records one Loader-composition case's terminal traffic and formats it per send. Sessions are
 * sequential in that case (a fresh terminal spawns only after the previous shell exited), so a
 * sanitizer is attributed to the most recently spawned terminal on its first chunk.
 */
export class ReadinessTimeline {
  private readonly origin = performance.now()
  private hostFactsText: string | undefined
  private seq = 0

  /**
   * @param hostFacts - host, shell, and console facts for the header; evaluated once, on the
   * first `format()` call, so a passing case never pays for a shell probe.
   */
  constructor(private readonly hostFacts: () => string = () => '') {}

  private readonly events: TimelineEvent[] = []
  private readonly sends: SendWindow[] = []
  private readonly sanitizers = new WeakMap<TerminalSanitizer, number>()
  private spawnCount = 0
  private currentLabel: string | undefined
  private labelUses = 0

  private now(): number {
    return Math.round(performance.now() - this.origin)
  }

  private push(event: RecordedEvent): void {
    this.events.push({ ...event, seq: this.seq, at: this.now() })
    this.seq += 1
  }

  /** Spy on every sanitizer's `push` so each decoded chunk is recorded with its prompt verdict. */
  observeSanitizer(): void {
    // oxlint-disable-next-line typescript/unbound-method -- the spy body re-binds it to each sanitizer through `call`.
    const original = TerminalSanitizer.prototype.push
    const record = (sanitizer: TerminalSanitizer, chunk: string, result: SanitizedChunk): void => {
      this.recordChunk(sanitizer, chunk, result)
    }
    vi.spyOn(TerminalSanitizer.prototype, 'push').mockImplementation(function (this: TerminalSanitizer, chunk: string): SanitizedChunk {
      const result = original.call(this, chunk)
      record(this, chunk, result)
      return result
    })
  }

  private recordChunk(sanitizer: TerminalSanitizer, chunk: string, result: SanitizedChunk): void {
    let session = this.sanitizers.get(sanitizer)
    if (session === undefined) {
      session = Math.max(0, this.spawnCount - 1)
      this.sanitizers.set(sanitizer, session)
    }
    this.push({
      kind: 'chunk',
      session,
      units: chunk.length,
      sample: sample(chunk),
      prompt: result.prompt,
      promptTail: result.promptTail,
      textLength: result.text.length,
    })
  }

  /**
   * Wrap one spawned terminal so its writes and foreground polls are recorded.
   * @param handle - the provider handle the session will drive.
   */
  observeTerminal(handle: SubprocessTerminalHandle): void {
    const session = this.spawnCount
    this.spawnCount += 1
    this.push({ kind: 'spawn', session, pid: handle.pid })
    const inspectForeground = handle.inspectForeground.bind(handle)
    vi.spyOn(handle, 'inspectForeground').mockImplementation(async (): Promise<SubprocessTerminalForeground | undefined> => {
      let foreground: SubprocessTerminalForeground | undefined
      try {
        foreground = await inspectForeground()
      } catch (error: unknown) {
        // A throwing inspection rejects the send; the window records what it threw.
        this.push({ kind: 'poll', session, foreground: `threw ${error instanceof Error ? error.message : String(error)}` })
        throw error
      }
      this.push({ kind: 'poll', session, foreground: foreground === undefined ? 'undefined' : JSON.stringify(foreground) })
      return foreground
    })
    const write = handle.write.bind(handle)
    vi.spyOn(handle, 'write').mockImplementation(async (data: string): Promise<void> => {
      const active = this.sends.at(-1)
      const input = active !== undefined && active.endSeq === undefined && data === active.input
      this.push({ kind: 'write', session, units: data.length, input })
      await write(data)
    })
  }

  /**
   * Name every send tracked until the next label; a second send under one label reads `label/2`.
   * @param label - the tool call id the sends belong to.
   */
  label(label: string): void {
    this.currentLabel = label
    this.labelUses = 0
  }

  /**
   * Open a send window and close it when the operation settles or rejects. Windows are bounded
   * by event sequence numbers, so two sends that hand over within one millisecond keep their
   * own events; the millisecond stamps are for display only.
   * @param operation - the send returned by `terminals.startSend`.
   * @param request - the request that send carries; its bytes identify the input write.
   */
  track(operation: TerminalSendOperation, request: TerminalSendRequest): void {
    this.labelUses += 1
    const label = this.currentLabel === undefined
      ? `send#${this.sends.length + 1}`
      : this.labelUses === 1 ? this.currentLabel : `${this.currentLabel}/${this.labelUses}`
    const window: SendWindow = {
      label,
      input: `${request.text}${request.submit ? '\r' : ''}`,
      startedAt: this.now(),
      startSeq: this.seq,
      settledAt: undefined,
      endSeq: undefined,
      outcome: 'pending',
    }
    this.sends.push(window)
    const close = (outcome: SendWindow['outcome']): void => {
      window.settledAt = this.now()
      window.endSeq = this.seq
      window.outcome = outcome
    }
    void operation.done.then((settled) => { close(settled.waitReason) }, () => { close('rejected') })
  }

  /**
   * Render every send window plus the traffic between windows (startup, restarts, late output).
   * @returns Multi-line text bounded per window: every prompt-bearing chunk, the first and last
   * chunks, poll totals by foreground value, and the replayed prompt evidence.
   */
  format(): string {
    this.hostFactsText ??= this.hostFacts()
    const lines: string[] = [TIMELINE_HEADER, ...this.hostFactsText.length > 0 ? [this.hostFactsText] : []]
    let cursor = 0
    let cursorAt = 0
    const windows: { title: string; from: number; fromAt: number; to: number; send: SendWindow | undefined }[] = []
    this.sends.forEach((send, index) => {
      if (send.startSeq > cursor) {
        windows.push({ title: index === 0 ? 'before the first send' : 'between sends', from: cursor, fromAt: cursorAt, to: send.startSeq, send: undefined })
      }
      const to = send.endSeq ?? this.seq
      windows.push({ title: `#${index + 1} ${send.label}`, from: send.startSeq, fromAt: send.startedAt, to, send })
      cursor = to
      cursorAt = send.settledAt ?? this.now()
    })
    windows.push({ title: 'after the last send', from: cursor, fromAt: cursorAt, to: this.seq, send: undefined })
    for (const window of windows) {
      const events = this.events.filter(event => event.seq >= window.from && event.seq < window.to)
      if (window.send === undefined && events.length === 0) continue
      lines.push(...this.formatWindow(window.title, window.fromAt, window.send, events))
    }
    return lines.join('\n')
  }

  private formatWindow(title: string, from: number, send: SendWindow | undefined, events: TimelineEvent[]): string[] {
    const lines: string[] = []
    const outcome = send === undefined
      ? ''
      : send.settledAt === undefined
        ? ` → still pending after ${this.now() - send.startedAt} ms`
        : ` → ${send.outcome} after ${send.settledAt - send.startedAt} ms`
    lines.push(`${title} (from +${from} ms)${outcome}`)
    for (const event of events) {
      if (event.kind === 'spawn') lines.push(`  +${event.at} spawn s${event.session} pid ${event.pid}`)
      if (event.kind === 'write') lines.push(`  +${event.at} write s${event.session} ${event.units} units (${event.input ? 'input' : 'reply'})`)
    }
    const polls = events.filter((event): event is PollEvent => event.kind === 'poll')
    if (polls.length > 0) {
      const byForeground = new Map<string, number>()
      for (const poll of polls) byForeground.set(poll.foreground, (byForeground.get(poll.foreground) ?? 0) + 1)
      const summary = [...byForeground].map(([foreground, count]) => `${foreground} ×${count}`).join(', ')
      lines.push(`  polls ${polls.length} (+${polls[0]?.at}…+${polls[polls.length - 1]?.at}): ${summary}`)
    }
    const chunks = events.filter((event): event is ChunkEvent => event.kind === 'chunk')
    if (chunks.length > 0) {
      const markers = chunks.filter(chunk => chunk.prompt).length
      lines.push(`  chunks ${chunks.length} (${markers} with a prompt marker)`)
      const shown = new Set<ChunkEvent>()
      chunks.slice(0, SHOWN_HEAD_CHUNKS).forEach(chunk => shown.add(chunk))
      chunks.slice(-SHOWN_TAIL_CHUNKS).forEach(chunk => shown.add(chunk))
      chunks.filter(chunk => chunk.prompt).forEach(chunk => shown.add(chunk))
      let elided = 0
      for (const chunk of chunks) {
        if (!shown.has(chunk)) {
          elided += 1
          continue
        }
        if (elided > 0) {
          lines.push(`  … ${elided} chunks elided …`)
          elided = 0
        }
        lines.push(`  +${chunk.at} s${chunk.session} ${chunk.units}u text=${chunk.textLength} marker=${chunk.prompt ? 'YES' : 'no'} tail=${tail(chunk.promptTail)} ${quoted(chunk.sample)}`)
      }
      if (send !== undefined) {
        // Readiness evidence resets at the send's input write; terminal-protocol replies the
        // emulator writes back do not reset it, so the replay starts at the last input write.
        const lastInput = events.filter((event): event is WriteEvent => event.kind === 'write' && event.input).at(-1)
        const evidence = replayPromptEvidence(chunks.filter(chunk => lastInput === undefined || chunk.seq > lastInput.seq))
        lines.push(`  replayed evidence at settle: promptSeen=${evidence.promptSeen} promptTail=${tail(evidence.promptTail)} promptTextSeen=${evidence.promptTextSeen}`)
      }
    }
    return lines
  }
}
