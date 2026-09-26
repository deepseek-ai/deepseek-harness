/** Runtime inspection, session queries, and workflow reports from recorded text. */
import type { ToolDetailsModel } from '../components/ToolDetails.tsx'
import { hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import {
  detailJson, detailList, detailRecord, inspectionItems,
  type DetailItem, type DetailTranslate,
} from './detail-model-shared.ts'

function dateText(value: string | number, locale: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return String(value)
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  } catch {
    return String(value)
  }
}

function cordisDetails(name: string, args: Record<string, unknown>, value: unknown, t: DetailTranslate): ToolDetailsModel | null {
  if (!detailRecord(value)) return null
  if (name === 'cordis_inspect_list') {
    if (!Array.isArray(value.providers)) return null
    return detailList(inspectionItems(value.providers, t), t('detail.providers.count', { count: value.providers.length }), t)
  }
  if (name === 'cordis_inspect_query') {
    if (!('data' in value) || typeof value.provider !== 'string' || typeof value.method !== 'string') return null
    return detailList(inspectionItems(value.data, t), `${value.provider}.${value.method}`, t)
  }
  if (name === 'cordis_inspect_self') {
    if (Array.isArray(value.plugins)) return detailList(inspectionItems(value.plugins, t), t('detail.plugins.count', { count: value.plugins.length }), t)
    return detailList(inspectionItems(value, t), String(args.pluginId ?? args.packageId ?? value.mode), t)
  }
  return null
}

function workflowDetails(name: string, args: Record<string, unknown>, text: string, t: DetailTranslate): ToolDetailsModel | null {
  if (name === 'workflow') {
    const match = /^workflow "([\s\S]*?)" completed \((\d+) agents?\)\.\nReturn value:\n([\s\S]*)$/u.exec(text)
    if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null
    const value = detailJson(match[3])
    if (value === undefined) return null
    const header: DetailItem = {
      title: match[1], badge: { label: t('detail.status.completed'), tone: 'success' },
      fields: [{ label: t('detail.field.agents'), value: match[2] }],
      ...(typeof args.code === 'string' ? { groups: [{ label: t('detail.workflow.script'), items: [{ fields: [], code: { text: args.code, language: 'javascript' } }] }] } : {}),
    }
    return detailList([header, ...inspectionItems(value, t)], match[1], t)
  }
  const separator = '\nFinal report:\n'
  const split = text.indexOf(separator)
  if (split < 0) return null
  const header = text.slice(0, split)
  const rounds = /\b(\d+) rounds?\b/u.exec(header)?.[1]
  const report = detailJson(text.slice(split + separator.length))
  if (!detailRecord(report) || typeof report.summary !== 'string' || !Array.isArray(report.evidence)
    || !report.evidence.every(value => typeof value === 'string') || !Array.isArray(report.nextSteps)
    || !report.nextSteps.every(value => typeof value === 'string') || typeof report.blocker !== 'string') return null
  const badge = header.startsWith('Ralph worker reported completion ')
    ? { label: t('detail.ralph.reportedComplete'), tone: 'success' as const }
    : header.startsWith('Ralph worker reported a blocker ')
      ? { label: t('detail.ralph.reportedBlocker'), tone: 'warning' as const }
      : header.startsWith('Ralph reached its ')
        ? { label: t('detail.ralph.limit'), tone: 'warning' as const } : undefined
  if (badge === undefined) return null
  const groups: NonNullable<DetailItem['groups']>[number][] = []
  if (report.nextSteps.length > 0) groups.push({ label: t('detail.report.nextSteps'), items: [{ fields: [], lines: report.nextSteps }] })
  if (typeof args.objective === 'string') groups.push({ label: t('detail.field.task'), items: [{ fields: [], description: args.objective }] })
  const fields = rounds === undefined ? [] : [{ label: t('detail.goal.rounds'), value: rounds }]
  if (report.blocker !== '') fields.push({ label: t('detail.goal.reason'), value: report.blocker })
  const item = { title: report.summary, badge, fields, ...(report.evidence.length === 0 ? {} : { lines: report.evidence }), groups }
  return detailList([item], report.summary, t)
}

const TRACE_FIELDS = {
  Created: 'detail.field.time', Availability: 'detail.field.availability', Parent: 'detail.field.parent',
  'Best match': 'detail.field.bestMatch', Target: 'detail.field.target',
  'Replaced by': 'detail.trace.replacedBy', 'Replacement chain': 'detail.trace.replacementChain',
  'Events replaced by target': 'detail.trace.replaces', 'Events cited directly as sources': 'detail.trace.sources',
  'Direct derived events': 'detail.trace.derived',
} as const

function textFields(text: string, t: DetailTranslate, locale: string): DetailItem['fields'] {
  return text.split('\n').flatMap((line) => {
    const match = /^\s*([^:]+): (.+)$/u.exec(line)
    if (match === null || match[1] === undefined || match[2] === undefined) return []
    const key = Object.hasOwn(TRACE_FIELDS, match[1]) ? TRACE_FIELDS[match[1] as keyof typeof TRACE_FIELDS] : undefined
    if (key === undefined) return []
    return [{ label: t(key), value: match[1] === 'Created' ? dateText(match[2], locale) : match[2] === 'none' ? t('detail.none') : match[2] }]
  })
}

function searchDetails(name: string, text: string, t: DetailTranslate, locale: string): ToolDetailsModel | null {
  if (text === 'No prior session matches found.' || text.endsWith('\n\nNo prior event matches found.')) return detailList([], t('detail.matches.count', { count: 0 }), t)
  const blocks = text.split(/\n(?=\d+\. )/u).filter(block => /^\d+\. /u.test(block))
  if (blocks.length === 0) return null
  const items: DetailItem[] = []
  for (const block of blocks) {
    const snippet = /\n\s*Snippet: ([\s\S]*?)(?:\n\nResult cap reached\.|$)/u.exec(block)?.[1]
    if (name === 'session_search') {
      const match = /^\d+\. Session (\S+) — (.*)/u.exec(block)
      if (match === null || match[1] === undefined || match[2] === undefined) return null
      items.push({
        title: match[2], subtitle: match[1], ...(snippet === undefined ? {} : { description: snippet.trimEnd() }),
        fields: textFields(block, t, locale),
      })
    } else {
      const match = /^\d+\. seq (\d+) \| ([^|]+) \| ([^|]+) \| ([^\n]+)/u.exec(block)
      if (match === null || match[1] === undefined || match[2] === undefined
        || match[3] === undefined || match[4] === undefined) return null
      items.push({ title: snippet?.trimEnd() ?? match[2], subtitle: `${match[2].trim()} · #${match[1]}`, fields: [{ label: t('detail.field.time'), value: dateText(match[4], locale) }, { label: t('detail.field.surface'), value: match[3].trim() }] })
    }
  }
  return {
    ...detailList(items, t('detail.matches.count', { count: items.length }), t),
    ...text.includes('Result cap reached.') ? { caption: t('detail.matches.capped') } : {},
  }
}

function eventReadDetails(text: string, t: DetailTranslate, locale: string): ToolDetailsModel | null {
  const match = /^Session (\S+) — ([^\n]*)\nTarget event seq (\d+):\n```json\n([\s\S]*?)\n```([\s\S]*)$/u.exec(text)
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) return null
  const event = detailJson(match[4])
  if (!detailRecord(event) || typeof event.type !== 'string' || !detailRecord(event.data)) return null
  const fields = [{ label: t('detail.field.seq'), value: match[3] }]
  if (typeof event.time === 'number') fields.push({ label: t('detail.field.time'), value: dateText(event.time, locale) })
  const groups: NonNullable<DetailItem['groups']>[number][] = []
  const adjacent = match[5]?.trim()
  if (adjacent) groups.push({ label: t('detail.event.neighbors'), items: [{ fields: [], description: adjacent }] })
  return detailList([
    { title: event.type, subtitle: `${match[2]} · ${match[1]}`, fields },
    ...inspectionItems(event.data, t),
    ...groups.length === 0 ? [] : [{ fields: [], groups }],
  ], `${event.type} · #${match[3]}`, t)
}

function traceDetails(name: string, text: string, t: DetailTranslate, locale: string): ToolDetailsModel | null {
  const match = /^Session (\S+) — ([^\n]*)\n([\s\S]*)$/u.exec(text)
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null
  if (name === 'session_event_trace') return detailList([{ title: match[2], subtitle: match[1], fields: textFields(match[3], t, locale) }], match[2], t)
  const sections = match[3].split('\n\n')
  const items: DetailItem[] = [{ title: match[2], subtitle: match[1], fields: textFields(sections[0] ?? '', t, locale) }]
  for (const section of sections.slice(1)) {
    const firstBreak = section.indexOf('\n')
    const label = section.startsWith('Ancestors (nearest first):') ? t('detail.trace.ancestors') : section.startsWith('Descendants:') ? t('detail.trace.descendants') : undefined
    if (label === undefined || firstBreak < 0) return null
    const body = section.slice(firstBreak + 1)
    items.push({ title: label, fields: [], ...(body === '- none' || body === '- none (target is a root session)' ? { description: t('detail.none') } : { lines: body.split('\n').map(line => line.replace(/^(\s*)- /u, '$1')) }) })
  }
  return detailList(items, match[2], t)
}

/**
 * Present successful inspection, query, and workflow text as named records.
 * @param name - Wire tool name.
 * @param args - Recorded argument object.
 * @param text - Recorded result text.
 * @param json - Parsed whole-result JSON, or undefined for non-JSON text.
 * @param t - Conversation translator.
 * @param locale - Date display locale.
 * @returns Structured details, or null when an output format is unknown.
 */
export function inspectionDetails(
  name: string, args: Record<string, unknown>, text: string, json: unknown, t: DetailTranslate, locale: string,
): ToolDetailsModel | null {
  if (hasSpillNotice(text)) return null
  switch (name) {
    case 'cordis_inspect_list':
    case 'cordis_inspect_query':
    case 'cordis_inspect_self': return cordisDetails(name, args, json, t)
    case 'workflow':
    case 'ralph': return workflowDetails(name, args, text, t)
    case 'session_search':
    case 'session_event_search': return searchDetails(name, text, t, locale)
    case 'session_event_read': return eventReadDetails(text, t, locale)
    case 'session_trace':
    case 'session_event_trace': return traceDetails(name, text, t, locale)
    default: return null
  }
}
