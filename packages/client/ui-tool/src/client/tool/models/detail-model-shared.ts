/** Recorded-value formatting shared by entity lists and inspection results. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolDetailItem, ToolDetailsModel } from '../components/ToolDetails.tsx'

/** Translator supplied by the conversation slot. */
export type DetailTranslate = TranslateNS<'conversation'>
/** A compact detail row derived from durable tool output. */
export type DetailItem = ToolDetailItem

/**
 * Narrow parsed JSON to an object record.
 * @param value - Parsed result or argument value.
 * @returns Whether named fields can be read.
 */
export function detailRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Check a recorded string field that must contain visible text.
 * @param value - Parsed field value.
 * @returns Whether the field is a non-empty string after trimming.
 */
export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Decode an entire JSON result without accepting a partial prefix.
 * @param text - Recorded text.
 * @returns Parsed JSON, or undefined for non-JSON output.
 */
export function detailJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch {
    // Text receipts and reports are decoded by their tool-specific adapters.
    return undefined
  }
}

const STATUS_KEYS = {
  running: 'detail.status.running', idle: 'detail.status.idle', ready: 'detail.status.ready',
  inactive: 'detail.status.inactive', provisioning: 'detail.status.provisioning',
  failed: 'detail.status.failed', error: 'detail.status.failed',
  completed: 'detail.status.completed', complete: 'detail.status.completed', done: 'detail.status.completed',
  pending: 'detail.todo.pending', in_progress: 'detail.todo.in_progress',
  deleted: 'detail.status.deleted', killed: 'detail.status.killed',
  blocked: 'detail.goal.blocked', accepted: 'detail.status.accepted', queued: 'detail.status.queued',
} as const

/**
 * Give a recorded status its localized name and a static semantic color.
 * @param status - Result status, retained verbatim when the vocabulary is unknown.
 * @param t - Conversation translator.
 * @returns A badge that does not imply a live subscription.
 */
export function detailBadge(status: string, t: DetailTranslate): NonNullable<DetailItem['badge']> {
  const key = Object.hasOwn(STATUS_KEYS, status) ? STATUS_KEYS[status as keyof typeof STATUS_KEYS] : undefined
  const tone = ['completed', 'complete', 'done', 'accepted'].includes(status) ? 'success'
    : ['failed', 'error'].includes(status) ? 'error'
      : ['blocked', 'killed', 'pending', 'queued', 'inactive'].includes(status) ? 'warning'
        : ['running', 'in_progress', 'provisioning'].includes(status) ? 'info' : 'neutral'
  return { label: key === undefined ? status : t(key), tone }
}

const FIELD_KEYS = {
  id: 'detail.field.id', revision: 'detail.field.revision', platform: 'detail.field.platform',
  provider: 'detail.field.provider', model: 'detail.field.model', role: 'detail.field.role',
  context: 'detail.field.context', ownerName: 'detail.field.owner', ready: 'detail.field.ready',
  blockedBy: 'detail.field.dependencies', writeScopes: 'detail.field.writeScopes',
  writeScopeWarnings: 'detail.field.warnings', diagnostics: 'detail.field.diagnostics',
  methods: 'detail.field.methods', inputSchema: 'detail.field.inputSchema', outputSchema: 'detail.field.outputSchema',
  currentPackageId: 'detail.field.currentPackage', nextPackageId: 'detail.field.nextPackage',
  latestRun: 'detail.field.latestRun', packages: 'detail.field.packages', registrations: 'detail.field.registrations',
  props: 'detail.field.props', data: 'detail.field.data', source: 'detail.field.source',
  arguments: 'row.input', content: 'detail.field.content', message: 'detail.field.message',
  messageId: 'detail.field.messageId', status: 'detail.state', root: 'detail.field.root',
  pid: 'detail.field.pid', type: 'detail.field.type', time: 'detail.field.time',
  seq: 'detail.field.seq', turn: 'detail.field.turn', step: 'detail.field.step', callId: 'detail.field.callId',
  agentsStarted: 'detail.field.agents', output: 'row.output', result: 'detail.field.result',
} as const

/**
 * Name a known tool field while preserving extension-owned field names.
 * @param key - Recorded JSON property name.
 * @param t - Conversation translator.
 * @returns Localized known label or the original property name.
 */
export function detailLabel(key: string, t: DetailTranslate): string {
  const label = Object.hasOwn(FIELD_KEYS, key) ? FIELD_KEYS[key as keyof typeof FIELD_KEYS] : undefined
  return label === undefined ? key : t(label)
}

function scalar(value: unknown, t: DetailTranslate): string {
  if (value === null) return t('detail.none')
  if (typeof value === 'boolean') return t(value ? 'detail.yes' : 'detail.no')
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const INSPECTION_KEY_ORDER = ['subject', 'title', 'name', 'pluginId', 'packageId', 'id', 'summary'] as const
const INSPECTION_DETAIL_KEYS = ['description', 'purpose'] as const
const MAX_INSPECTION_ITEMS = 40

/**
 * Project open inspection records into readable fields and named disclosures.
 * @param value - Parsed JSON, including provider-owned extension fields.
 * @param t - Conversation translator.
 * @param depth - Current disclosure depth; deeper records remain available as code.
 * @returns Entity rows preserving the order of visible values.
 */
export function inspectionItems(value: unknown, t: DetailTranslate, depth = 0): DetailItem[] {
  if (depth > 4 && value !== null && typeof value === 'object') {
    return [{ code: { text: JSON.stringify(value, null, 2), language: 'json' }, fields: [] }]
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_INSPECTION_ITEMS).flatMap(entry => inspectionItems(entry, t, depth + 1))
    if (value.length > MAX_INSPECTION_ITEMS) items.push({ description: t('detail.moreInInspect', { count: value.length - MAX_INSPECTION_ITEMS }), fields: [] })
    return items.length === 0 ? [{ description: t('detail.empty'), fields: [] }] : items
  }
  if (!detailRecord(value)) return [{ description: scalar(value, t), fields: [] }]
  const titleKey = INSPECTION_KEY_ORDER.find(key => typeof value[key] === 'string' && value[key] !== '')
  const descriptionKey = INSPECTION_DETAIL_KEYS.find(key => typeof value[key] === 'string' && value[key] !== '')
  const title = titleKey === undefined ? undefined : String(value[titleKey])
  const fields: DetailItem['fields'][number][] = []
  const groups: NonNullable<DetailItem['groups']>[number][] = []
  for (const [key, field] of Object.entries(value)) {
    if (key === titleKey || key === descriptionKey || (key === 'status' && typeof field === 'string')) continue
    if (key === 'inputSchema' || key === 'outputSchema') {
      groups.push({
        label: detailLabel(key, t),
        items: [{ fields: [], code: { text: JSON.stringify(field, null, 2), language: 'json' } }],
      })
      continue
    }
    if (Array.isArray(field) && field.length === 0) continue
    if (key === 'arguments' && typeof field === 'string') {
      const args = detailJson(field)
      if (detailRecord(args)) { groups.push({ label: detailLabel(key, t), items: inspectionItems(args, t, depth + 1) }); continue }
    }
    if (field !== null && typeof field === 'object') groups.push({ label: detailLabel(key, t), items: inspectionItems(field, t, depth + 1) })
    else fields.push({ label: detailLabel(key, t), value: scalar(field, t) })
  }
  return [{
    ...(title === undefined && typeof value.status !== 'string' ? {} : { title: title ?? t('detail.field.result') }),
    ...(descriptionKey === undefined ? {} : { description: String(value[descriptionKey]) }),
    ...(typeof value.status === 'string' ? { badge: detailBadge(value.status, t) } : {}),
    fields,
    ...(groups.length === 0 ? {} : { groups }),
  }]
}

/**
 * Give a result list consistent historical context and empty-state copy.
 * @param items - Recorded result rows.
 * @param summary - Collapsed-row summary.
 * @param t - Conversation translator.
 * @returns A complete compact detail model.
 */
export function detailList(items: readonly DetailItem[], summary: string, t: DetailTranslate): ToolDetailsModel {
  return { items, summary, caption: t('detail.recordedResult'), empty: t('detail.empty') }
}
