/** Immutable system-only interpretation of the loaded Session surface. */
import { extractTextContent } from '@deepseek-ai/dsh-llm/message'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { isSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {
  EffectiveSystemSection, SystemMessageSections, SystemPromptNode, SystemSectionChange,
} from './request-inspection.ts'

/** Source states one system message records, with their text resolved from its blocks. */
interface SectionRecords {
  readonly reset: boolean
  readonly active: readonly EffectiveSystemSection[]
  readonly retired: readonly string[]
}

interface PositionedSystem {
  readonly position: number
  readonly node: SystemPromptNode
  /** Absent for a message without section metadata. */
  readonly records?: SectionRecords
}

/** Prompt facts at one log prefix; earlier instances remain valid for historical cards. */
export interface SystemPromptState {
  /** Earliest relevant loaded event; older unindexed endpoints have unknown surface positions. */
  readonly firstSeq: number
  /** Missing endpoint order makes the prompt unavailable until prepend replay supplies it. */
  readonly uncertain: boolean
  /** Loaded system nodes in surface order, including empty dormant nodes. */
  readonly nodes: readonly PositionedSystem[]
  /** Surviving replacement endpoints only, mapped to inherited surface positions. */
  readonly replacements: ReadonlyMap<number, number>
  /** Effective prompt and its change origin; empty text records removal, undefined means unavailable. */
  readonly effective: SystemPromptNode | undefined
  /** System event at this position, if any; only this node may own an update card. */
  readonly introduced: SystemPromptNode | undefined
  /**
   * Instructions in force per source, including sources cleared to empty text.
   * Undefined while unavailable: a retained nonempty message lacks section metadata, or the prompt is uncertain.
   */
  readonly sections: readonly EffectiveSystemSection[] | undefined
}

/** Pure interpretation supplied to target-owned Definitions through uiConversation. */
export type SystemPromptInspector = (previous: SystemPromptState | undefined, event: SessionEvent) => SystemPromptState

/** Trimmed text of the block at `index`; empty for a missing or non-text block. */
function blockText(event: SessionEvent<'system/message'>, index: number): string {
  const block = event.data.message.content[index]
  return block?.type === 'text' ? block.text.trim() : ''
}

/**
 * Classify each source one system message names against the instructions in force before it.
 * @param event - System message to read.
 * @param baseline - Instructions in force before the message; undefined when unknown, which classifies as none.
 * @returns The section reading and its source records, or undefined without section metadata.
 */
function readSections(
  event: SessionEvent<'system/message'>,
  baseline: readonly EffectiveSystemSection[] | undefined,
): { readonly message: SystemMessageSections; readonly records: SectionRecords } | undefined {
  const source = event.data.message.source
  if (source.sections === undefined) return undefined
  const before = new Map((baseline ?? []).map(section => [section.name, section]))
  const attributed = new Set<number>()
  const active: EffectiveSystemSection[] = []
  const retired: string[] = []
  const positioned: { readonly at: number; readonly change: SystemSectionChange }[] = []
  for (const section of source.sections) {
    const noticeIndex = section.noticeIndex ?? []
    for (const index of noticeIndex) attributed.add(index)
    const notices = noticeIndex.map(index => blockText(event, index)).filter(Boolean)
    if (section.state === 'retired') {
      retired.push(section.name)
      positioned.push({
        at: Math.min(...noticeIndex, Infinity),
        change: { name: section.name, change: 'removed', text: '', notices },
      })
      continue
    }
    attributed.add(section.contentIndex)
    const text = blockText(event, section.contentIndex)
    const previous = before.get(section.name)
    let change: SystemSectionChange['change']
    if (previous === undefined) change = 'added'
    else if (previous.text !== text) change = text === '' ? 'cleared' : 'updated'
    else if (previous.order !== section.order) change = 'reordered'
    else change = 'unchanged'
    active.push({ name: section.name, order: section.order, text })
    positioned.push({
      at: Math.min(section.contentIndex, ...noticeIndex),
      change: { name: section.name, change, text, notices },
    })
  }
  const reset = source.reset === true
  return {
    message: {
      changes: positioned.sort((a, b) => a.at - b.at).map(item => item.change),
      notices: event.data.message.content
        .map((_block, index) => attributed.has(index) ? '' : blockText(event, index))
        .filter(Boolean),
      reset,
    },
    records: { reset, active, retired },
  }
}

/**
 * Fold the retained system messages into the instructions in force per source.
 * @param nodes - Retained system nodes in surface order.
 * @returns Sources by prompt order then name, or undefined when a nonempty message without section metadata still applies.
 */
function effectiveSections(nodes: readonly PositionedSystem[]): readonly EffectiveSystemSection[] | undefined {
  let sections: Map<string, EffectiveSystemSection> | undefined = new Map()
  for (const { node, records } of nodes) {
    if (records === undefined) {
      if (node.text !== '') sections = undefined
      continue
    }
    if (records.reset) sections = new Map()
    if (sections === undefined) continue
    for (const section of records.active) sections.set(section.name, section)
    for (const name of records.retired) sections.delete(name)
  }
  if (sections === undefined) return undefined
  return [...sections.values()].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Whether two per-source lists name the same sources with the same order and text. */
function sameSections(
  left: readonly EffectiveSystemSection[] | undefined,
  right: readonly EffectiveSystemSection[] | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((section, index) => {
    const other = right[index]
    return other !== undefined && other.name === section.name && other.order === section.order && other.text === section.text
  })
}

/** Insert one system node at its surface position. */
function withNode(nodes: readonly PositionedSystem[], entry: PositionedSystem): readonly PositionedSystem[] {
  return [...nodes, entry].sort((a, b) => a.position - b.position)
}

/**
 * Apply a system event or positional replacement without retaining ordinary messages.
 * Replacement positions inherit their start endpoint, not their chronological seq.
 * Unknown older endpoint order withholds the prompt until prepend replay resolves it.
 * Messages carrying section metadata also yield the instructions in force per source, also attached to the node the
 * message introduces; an in-history update additionally yields its per-source reading against the instructions in
 * force before it. The effective prompt changes when either its text or its per-source instructions change.
 * @param previous - Interpretation at the preceding relevant event in the loaded window.
 * @param event - System message or surface replacement already admitted by Session.
 * @returns Immutable surviving system facts and the effective nonempty prompt.
 */
export function inspectSystemPrompt(previous: SystemPromptState | undefined, event: SessionEvent): SystemPromptState {
  const op = isSurfaceEvent(event) ? event.surfaceOp : undefined
  const firstSeq = previous?.firstSeq ?? event.seq
  let nodes: readonly PositionedSystem[] = previous?.nodes ?? []
  let replacements = previous?.replacements ?? new Map<number, number>()
  const unknownEndpoint = (seq: number): boolean => seq < firstSeq && !replacements.has(seq)
  const uncertain = previous?.uncertain === true || (op !== undefined && op !== 'append'
    && (unknownEndpoint(op.startSeq) || unknownEndpoint(op.endSeq)))
  if (uncertain) {
    return {
      firstSeq, uncertain, nodes: [], replacements: new Map(), effective: undefined, introduced: undefined,
      sections: undefined,
    }
  }
  let position: number = event.seq
  if (op !== undefined && op !== 'append') {
    position = replacements.get(op.startSeq) ?? op.startSeq
    const end = replacements.get(op.endSeq) ?? op.endSeq
    nodes = nodes.filter(item => item.position < position || item.position > end)
    const retained = new Map([...replacements].filter(([, value]) => value < position || value > end))
    retained.set(event.seq, position)
    replacements = retained
  }
  let introduced: SystemPromptNode | undefined
  let sections: readonly EffectiveSystemSection[] | undefined
  if (event.type === 'system/message') {
    const read = readSections(event, previous?.sections)
    const update = op === 'append' && previous?.nodes.some(item => item.node.text !== '') === true
    const records = read?.records
    const node: SystemPromptNode = {
      seq: event.seq,
      time: event.time,
      turn: event.data.turn,
      step: event.data.step,
      text: extractTextContent(event.data.message.content, { separator: '\n\n', trim: true }),
      update,
      ...(update && read !== undefined ? { message: read.message } : {}),
    }
    const entry = (value: SystemPromptNode): PositionedSystem => ({
      position, node: value, ...(records === undefined ? {} : { records }),
    })
    // The fold reads only texts and records, so the instructions in force can be attached to the node it inserts.
    sections = effectiveSections(withNode(nodes, entry(node)))
    introduced = sections === undefined ? node : { ...node, sections }
    nodes = withNode(nodes, entry(introduced))
  } else {
    sections = effectiveSections(nodes)
  }
  const nonEmpty = nodes.filter(item => item.node.text !== '')
  const surviving = nonEmpty.at(-1)?.node
  const text = nonEmpty.map(item => item.node.text).join('\n\n')
  let effective = previous?.effective
  // An empty prompt never becomes the first effective prompt; afterwards, a text-less update that clears or
  // reorders a source still changes the instructions in force.
  const changed = effective === undefined
    ? text !== ''
    : effective.text !== text || !sameSections(effective.sections, sections)
  if (changed) {
    effective = {
      seq: event.seq,
      time: event.time,
      turn: surviving?.turn ?? 0,
      step: surviving?.step ?? 0,
      text,
      update: introduced?.update === true,
      ...(op !== undefined && op !== 'append' ? { rebuilt: true as const } : {}),
      ...(sections === undefined ? {} : { sections }),
      ...(introduced?.message === undefined ? {} : { message: introduced.message }),
    }
  }
  return { firstSeq, uncertain, nodes, replacements, effective, introduced, sections }
}
