/**
 * Turn-scoped produced-file Definition and readers. Client-only and
 * model-free: produced paths come from successful first-party mutation calls,
 * changed files from the Host's recorded git summary, and deliveries from
 * `present`; never from presentation data or the closing prose.
 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PresentedFile } from '@deepseek-ai/dsh-tool-present/types'
import { isChangesEvent } from '../changes.ts'
import { basename, isPresentedData, isPresentedFile } from '../presented.ts'

/** A declared file with its authorized open coordinates. */
export interface PresentedPath extends PresentedFile {
  readonly seq: number
  readonly index: number
}

interface ProducedPath {
  readonly seq: number
  readonly path: string
}

/** The latest `workspace/changes` announcement of one Turn; the Host serves its summary by this sequence. */
export interface ChangesTurnData {
  readonly seq: number
}

/** Immutable produced-file facts published against one Turn. */
export interface DeliverablesTurnData {
  readonly produced: readonly ProducedPath[]
  readonly presented?: readonly PresentedPath[]
  readonly changes?: ChangesTurnData
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Successful mutation paths, recorded changed files, and deliveries accumulated in this Turn. */
    deliverables: DeliverablesTurnData
  }
}

interface DeliverablesState extends DeliverablesTurnData {
  readonly turn: number
  readonly calls: ReadonlyMap<string, string | null>
}

/**
 * Extract the path from a supported first-party mutation call. Session
 * `tool/call` events are root calls; PTC dispatch children do not enter this
 * Definition independently.
 * @param name - wire tool name.
 * @param argsRaw - model-produced JSON arguments.
 * @returns the mutation path, or null when the call is not a supported mutation.
 */
function mutationPath(name: string, argsRaw: string): string | null {
  let args: unknown
  try {
    args = JSON.parse(argsRaw) as unknown
  } catch {
    return null
  }
  if (!isRecord(args)) return null
  switch (name) {
    case 'write':
      return typeof args.content === 'string' ? pathValue(args.file_path) : null
    case 'edit':
      return validEditArgs(args) ? pathValue(args.file_path) : null
    case 'str_replace_editor':
      return editorMutationPath(args)
    default:
      return null
  }
}

/** Validate the fields that an `edit` execution requires. */
function validEditArgs(args: Readonly<Record<string, unknown>>): boolean {
  return typeof args.old_string === 'string'
    && args.old_string.length > 0
    && typeof args.new_string === 'string'
    && args.old_string !== args.new_string
    && (args.replace_all === undefined || typeof args.replace_all === 'boolean')
}

/** Extract a path only from a complete mutating editor command. */
function editorMutationPath(args: Readonly<Record<string, unknown>>): string | null {
  const path = pathValue(args.path)
  if (path === null) return null
  switch (args.command) {
    case 'create':
      return typeof args.file_text === 'string' ? path : null
    case 'str_replace':
      return typeof args.old_str === 'string'
        && args.old_str.length > 0
        && (args.new_str === undefined || typeof args.new_str === 'string')
        ? path
        : null
    case 'insert':
      return typeof args.insert_line === 'number'
        && Number.isInteger(args.insert_line)
        && args.insert_line >= 0
        && typeof args.new_str === 'string'
        ? path
        : null
    default:
      return null
  }
}

/** A non-blank path preserves the exact spelling supplied to the tool. */
function pathValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** Narrow parsed JSON to an argument object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Files produced by one Turn data value.
 *
 * The source is the arguments of successful `write`, `edit`, and mutating
 * `str_replace_editor` calls, not the closing prose: a produced file must be
 * listed whether or not the model remembered to name it. Reads, unsupported
 * tools, malformed calls, and failed results contribute nothing. Paths keep
 * first-seen order and appear once, so a file written and then edited in the
 * same turn is one entry.
 *
 * The Conversation Location index owns turn membership before this function
 * runs, so paths cannot spill across turns and this derivation does not infer
 * boundaries from neighboring presentation Nodes.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @returns Produced paths in first-seen order; empty when the turn wrote nothing.
 */
export function producedForClosing(
  data: Readonly<DeliverablesTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly string[] {
  if (data === undefined) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const produced of data.produced) {
    if (produced.seq > seq || seen.has(produced.path)) continue
    seen.add(produced.path)
    paths.push(produced.path)
  }
  return paths
}

/**
 * Claim the turn-tail chain only when its closing turn produced files.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns Produced paths as the component's match, or null to decline before mount.
 */
export function selectProducedFiles(owner: TurnTailOwnerProps): readonly string[] | null {
  const paths = producedForClosing(owner.turn.data.get('deliverables'), owner.seq)
  return paths.length === 0 ? null : paths
}

/** Turn-local successful mutation accumulator; it publishes no view Node. */
export const deliverablesDefinition: ConversationNodeDefinition<DeliverablesState> = {
  kind: 'deliverables',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'deliverables/presented') return isPresentedData(event.data) ? { id: String(event.data.turn), role: 'update' } : null
    if (event.type === 'workspace/changes') return isChangesEvent(event.data) ? { id: String(event.data.turn), role: 'update' } : null
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('deliverables start requires turn/start')
    return { turn: match.event.data.turn, calls: new Map(), produced: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'workspace/changes') return { ...context.state, changes: { seq: match.event.seq } }
    if (match.event.type === 'deliverables/presented') {
      const { files } = match.event.data
      const seq = match.event.seq
      const presented: PresentedPath[] = []
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        if (isPresentedFile(file)) presented.push({ ...file, seq, index })
      }
      if (presented.length === 0) return context.state
      return { ...context.state, presented: [...context.state.presented ?? [], ...presented] }
    }
    if (match.event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      calls.set(
        String(match.event.data.callId),
        mutationPath(match.event.data.name, match.event.data.arguments),
      )
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result') return context.state
    if (match.event.data.message.isError === true) return context.state
    const callId = String(match.event.data.message.source.callId)
    const path = context.state.calls.get(callId)
    return path === null || path === undefined
      ? context.state
      : { ...context.state, produced: [...context.state.produced, { seq: match.event.seq, path }] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'deliverables'
      && previous.value.produced === context.state.produced
      && previous.value.presented === context.state.presented
      && previous.value.changes === context.state.changes) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'deliverables',
      value: {
        produced: context.state.produced,
        ...context.state.presented === undefined ? {} : { presented: context.state.presented },
        ...context.state.changes === undefined ? {} : { changes: context.state.changes },
      },
    }
  },
}

/**
 * The turn's latest change announcement.
 * @param owner - closing turn.
 * @returns the announcement, or null when the Host recorded none.
 */
export function changesForClosing(owner: TurnTailOwnerProps): ChangesTurnData | null {
  return owner.turn.data.get('deliverables')?.changes ?? null
}

/**
 * Select the latest declaration of each path before the closing reply.
 * @param owner - closing turn and sequence.
 * @returns replayable deliveries in first-seen path order.
 */
export function presentedForClosing(owner: TurnTailOwnerProps): PresentedPath[] {
  const files = new Map<string, PresentedPath>()
  for (const file of owner.turn.data.get('deliverables')?.presented ?? []) {
    if (file.seq < owner.seq) files.set(file.path, file)
  }
  return [...files.values()]
}

export { basename } from '../presented.ts'

/**
 * Resolves inline-code references against one turn's produced or delivered
 * paths. Exact paths resolve directly; a basename resolves only when exactly
 * one supplied path has that basename. Ambiguous and unknown tokens stay inert.
 * @param paths - The turn's produced or delivered paths, already deduplicated.
 * @param openFile - The chat view's file opener.
 * @param label - Localizes the accessible open-label for a resolved path.
 * @returns The resolver MarkdownText consumes; the full path rides `title`,
 * the same disambiguator the row's chips carry.
 */
export function producedFileMentions(
  paths: readonly string[],
  openFile: (path: string) => void,
  label: (path: string) => string,
): MarkdownFileMentions {
  return {
    resolve(value) {
      const path = paths.includes(value) ? value : onlyPathWithBasename(paths, value)
      if (path === undefined) return undefined
      return { open: () => { openFile(path) }, label: label(path), title: path }
    },
  }
}

/** The single supplied path whose basename is exactly `value`, else undefined. */
function onlyPathWithBasename(paths: readonly string[], value: string): string | undefined {
  const matches = paths.filter(path => basename(path) === value)
  return matches.length === 1 ? matches[0] : undefined
}
