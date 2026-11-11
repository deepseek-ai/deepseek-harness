/** Entity lists and receipts for agent, job, terminal, and language-server tools. */
import type { ToolDetailsModel } from '../components/ToolDetails.tsx'
import {
  detailBadge, detailList, detailRecord, inspectionItems, nonempty,
  type DetailItem, type DetailTranslate,
} from './detail-model-shared.ts'

const OUTPUT_TRUNCATED = '\n[output truncated]'

function arg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function receipt(title: string, badge: NonNullable<DetailItem['badge']>, t: DetailTranslate, fields: DetailItem['fields'] = [], description?: string): ToolDetailsModel {
  return {
    ...detailList([{ title, badge, fields, ...(description === undefined ? {} : { description }) }], `${title} · ${badge.label}`, t),
    expandedSummary: title,
  }
}

/** Localize task ownership without interpreting inspection providers' own `owner` fields. */
function teamTaskItems(value: unknown, t: DetailTranslate): DetailItem[] {
  return inspectionItems(value, t).map(item => ({
    ...item,
    fields: item.fields.map(field => field.label === 'owner'
      ? { ...field, label: t('detail.field.owner') } : field),
  }))
}

function agentList(text: string, json: unknown, t: DetailTranslate): ToolDetailsModel | null {
  if (Array.isArray(json)) {
    const items = inspectionItems(json, t).map((item) => {
      if (item.title === undefined || item.description === undefined) return item
      const { title, description, ...rest } = item
      return { ...rest, title: description, subtitle: title }
    })
    return { ...detailList(items, t('detail.agents.count', { count: json.length }), t), compact: true }
  }
  if (text === '(no subagents)') return detailList([], t('detail.agents.count', { count: 0 }), t)
  const items: DetailItem[] = []
  for (const line of text.split('\n')) {
    // Historical rows name agents by Session ID and carry parent and depth.
    const match = /^(\S+) \[([^\]]+)\](?: parent=\S+ depth=\d+)?(?: — (.*))?$/u.exec(line)
    if (match === null) return null
    const [, agent, state, title] = match
    if (agent === undefined || state === undefined) return null
    items.push({
      title: title || agent, ...(title ? { subtitle: agent } : {}),
      badge: detailBadge(state, t),
      fields: [],
    })
  }
  return { ...detailList(items, t('detail.agents.count', { count: items.length }), t), compact: true }
}

function jobList(text: string, t: DetailTranslate): ToolDetailsModel | null {
  if (text === '(no background jobs)') return detailList([], t('detail.jobs.count', { count: 0 }), t)
  const items: DetailItem[] = []
  for (const line of text.split('\n')) {
    const match = /^(\S+) \[([^\]]+)\] (\S+) — (.*)$/u.exec(line)
    if (match === null) return null
    const [, id, kind, state, title] = match
    if (id === undefined || kind === undefined || state === undefined || title === undefined) return null
    items.push({ title, subtitle: id, badge: detailBadge(state, t), fields: [{ label: t('detail.field.type'), value: kind }] })
  }
  return detailList(items, t('detail.jobs.count', { count: items.length }), t)
}

function terminalList(text: string, t: DetailTranslate): ToolDetailsModel | null {
  if (text === '(no terminal sessions)') return detailList([], t('detail.terminals.count', { count: 0 }), t)
  const items: DetailItem[] = []
  for (const line of text.split('\n')) {
    const match = /^(\S+)(?: \((.*?)\))? \[([^\]]+)\] (running|exited code=(\S+) signal=(\S+))(?: pid=(\d+))?$/u.exec(line)
    if (match === null) return null
    const [, id, name, type, state, exitCode, signal, pid] = match
    if (id === undefined || type === undefined || state === undefined) return null
    const fields = [{ label: t('detail.field.type'), value: type }]
    if (pid !== undefined) fields.push({ label: t('detail.field.pid'), value: pid })
    if (exitCode !== undefined) fields.push({ label: t('detail.field.exitCode'), value: exitCode })
    if (signal !== undefined && signal !== 'null') fields.push({ label: t('detail.field.signal'), value: signal })
    items.push({
      title: name ?? id, ...(name === undefined ? {} : { subtitle: id }),
      badge: state === 'running' ? detailBadge('running', t) : { label: t('detail.status.exited'), tone: exitCode === '0' ? 'success' : 'neutral' }, fields,
    })
  }
  return detailList(items, t('detail.terminals.count', { count: items.length }), t)
}

function lspDetails(args: Record<string, unknown>, text: string, t: DetailTranslate): ToolDetailsModel | null {
  const file = arg(args, 'file_path')
  const operation = arg(args, 'operation')
  if (file === '' || typeof args.line !== 'number' || typeof args.character !== 'number') return null
  const source = `${file}:${args.line}:${args.character}`
  if (operation === 'hover') return detailList([{ title: source, location: { path: file, line: args.line }, markdown: text, fields: [] }], source, t)
  if (text === 'No results.') return detailList([], t('detail.locations.count', { count: 0 }), t)
  const items: DetailItem[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('… ')) { items.push({ description: line, fields: [] }); continue }
    const match = /^(.*):(\d+):(\d+)$/u.exec(line)
    if (match === null) return null
    const [, path, row, column] = match
    if (path === undefined || row === undefined || column === undefined) return null
    const isUri = /^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)
    items.push({
      title: path, subtitle: t('detail.location', { line: row, column }), fields: [],
      ...isUri ? {} : { location: { path, line: Number(row) } },
    })
  }
  const count = items.filter(item => item.title !== undefined).length
  return detailList(items, `${file} · ${t('detail.locations.count', { count })}`, t)
}

/**
 * Read a successful delegation receipt from persisted metadata or historical text.
 * @param args - Recorded creation arguments, including description and full prompt.
 * @param text - Single recorded text block; absent for other content layouts.
 * @param meta - Tool-owned result metadata; only absent metadata permits legacy text parsing.
 *   Its `name` is the child's model-facing agent name and is absent from receipts recorded before agents had names.
 * @param t - Conversation translator.
 * @returns Started task details, a historical synchronous reply, or null for unsupported data.
 */
export function subagentDetails(
  args: Record<string, unknown>, text: string | undefined, meta: unknown, t: DetailTranslate,
): ToolDetailsModel | null {
  const fields: DetailItem['fields'][number][] = []
  const description = arg(args, 'description')
  if (nonempty(description)) fields.push({ label: t('detail.field.agentDescription'), value: description })
  if (meta !== undefined) {
    if (!detailRecord(meta) || meta.kind !== 'activation') return null
    if (meta.name !== undefined && !nonempty(meta.name)) return null
    if (meta.subagentId !== undefined && !nonempty(meta.subagentId)) return null
    if (meta.name === undefined && meta.subagentId === undefined) return null
    if (meta.name !== undefined) fields.push({ label: t('detail.field.agentName'), value: meta.name })
    if (meta.subagentId !== undefined) fields.push({ label: t('detail.field.id'), value: meta.subagentId })
  } else {
    if (text === undefined) return null
    // Historical results lack the structured receipt stored by current tools.
    const started = /^started (background subagent job|subagent) (\S+)$/u.exec(text)
    if (started === null) {
      return detailList([{ title: t('detail.agent.reply'), markdown: text, fields: [], groups: [{ label: t('detail.field.task'), items: [{ description: arg(args, 'prompt'), fields: [] }] }] }], t('detail.agent.reply'), t)
    }
    if (started[1] === 'background subagent job') fields.push({ label: t('detail.field.job'), value: started[2] ?? '' })
    else fields.push({ label: t('detail.field.id'), value: started[2] ?? '' })
  }
  return detailList([{
    title: t('detail.receipt.started'), fields,
    groups: [{ label: t('detail.field.task'), items: [{ description: arg(args, 'prompt'), fields: [] }] }],
  }], description || arg(args, 'prompt'), t)
}

/**
 * Derive entity lists and operation receipts from supported recorded output formats.
 * @param name - Wire tool name, including Team-scoped aliases.
 * @param args - Parsed recorded arguments.
 * @param text - Successful recorded result text.
 * @param json - Parsed whole-result JSON, or undefined for non-JSON text.
 * @param t - Conversation translator.
 * @returns Compact details, or null when the output format is not recognized.
 */
export function controlDetails(
  name: string, args: Record<string, unknown>, text: string, json: unknown, t: DetailTranslate,
): ToolDetailsModel | null {
  // Historical `send_message` and `interrupt_agent` records name their target with `agent_id`.
  const target = arg(args, 'target') || arg(args, 'agent') || arg(args, 'agent_id') || arg(args, 'sessionId') || arg(args, 'job_id')
  switch (name) {
    case 'list_agents': return agentList(text, json, t)
    case 'job_list': return jobList(text, t)
    case 'terminal_list': return terminalList(text, t)
    case 'lsp': return lspDetails(args, text, t)
    case 'spawn_teammate':
      if (!detailRecord(json) || !detailRecord(json.member)) return null
      return detailList(inspectionItems(json.member, t), arg(args, 'name'), t)
    case 'team_task_create':
    case 'team_task_get':
    case 'team_task_update':
      if (!detailRecord(json) || typeof json.subject !== 'string') return null
      return detailList(teamTaskItems(json, t), json.subject, t)
    case 'team_task_list':
      if (!detailRecord(json) || !Array.isArray(json.tasks)) return null
      if (json.nextCursor !== undefined && typeof json.nextCursor !== 'number') return null
      return {
        ...detailList(teamTaskItems(json.tasks, t), t('detail.tasks.count', { count: json.tasks.length }), t),
        ...(json.nextCursor === undefined ? {} : { caption: t('detail.tasks.nextPage', { cursor: String(json.nextCursor) }) }),
      }
    case 'send_message': {
      const status = detailRecord(json) ? json.status : undefined
      if (status === 'accepted' || status === 'queued') return receipt(target, {
        label: t(status === 'queued' ? 'detail.status.queued' : 'detail.receipt.delivered'), tone: status === 'queued' ? 'warning' : 'success',
      }, t, [], arg(args, 'message'))
      return text === `message delivered to agent ${target}` ? receipt(target, { label: t('detail.receipt.delivered'), tone: 'success' }, t, [], arg(args, 'message')) : null
    }
    case 'interrupt_agent':
      if (detailRecord(json) && typeof json.previousStatus === 'string') return receipt(target, { label: t('detail.receipt.interrupt'), tone: 'warning' }, t, [{ label: t('detail.field.previousStatus'), value: detailBadge(json.previousStatus, t).label }])
      return text === `interrupt requested for agent ${target}` ? receipt(target, { label: t('detail.receipt.interrupt'), tone: 'warning' }, t) : null
    case 'wait_agent': {
      if (!detailRecord(json) || typeof json.timedOut !== 'boolean') return null
      if (detailRecord(json.noProgress) && typeof json.noProgress.message === 'string') return detailList([{ title: t('detail.wait.noProgress'), description: json.noProgress.message, fields: [] }], t('detail.wait.noProgress'), t)
      const label = t(json.timedOut ? 'detail.wait.timeout' : 'detail.wait.ended')
      return {
        ...receipt(t('detail.wait.title'), { label, tone: 'neutral' }, t),
        summary: label,
        expandedSummary: '',
      }
    }
    case 'list_subagent_models': {
      const items = text.split('\n').map((line) => {
        const split = line.indexOf(' — ')
        return split < 0
          ? { description: line, fields: [] }
          : { title: line.slice(0, split), description: line.slice(split + 3), fields: [] }
      })
      return detailList(items, arg(args, 'model') || arg(args, 'provider') || t('detail.models.title'), t)
    }
    case 'job_output': {
      const match = /\n\[status: ([^,\]\n]+)(?:, ([^\]\n]+))?\]$/u.exec(text)
      if (match === null || match[1] === undefined) return null
      const output = text.slice(0, match.index)
      const truncated = output.endsWith(OUTPUT_TRUNCATED)
      const code = truncated ? output.slice(0, -OUTPUT_TRUNCATED.length) : output
      const description = [match[2], truncated ? t('detail.output.truncated') : undefined]
        .filter((value): value is string => value !== undefined).join(' · ')
      return {
        ...detailList([{ title: target, badge: detailBadge(match[1], t), fields: [], ...(description === '' ? {} : { description }), code: { text: code } }], `${target} · ${detailBadge(match[1], t).label}`, t),
        expandedSummary: target,
      }
    }
    case 'job_kill':
      if (text === `requested cancellation of job ${target}`) return receipt(target, { label: t('detail.receipt.cancel'), tone: 'warning' }, t, [], arg(args, 'reason'))
      if (text.startsWith(`job ${target} had already finished `)) return receipt(target, { label: t('detail.receipt.alreadyFinished'), tone: 'neutral' }, t)
      return null
    case 'terminal_open': {
      const match = /^started terminal session (\S+)(?: \((.*?)\))? \[type: ([^\]]+)\]\n([\s\S]*)$/u.exec(text)
      if (match === null || match[1] === undefined || match[3] === undefined || match[4] === undefined) return null
      return detailList([{ title: match[2] ?? match[1], ...(match[2] === undefined ? {} : { subtitle: match[1] }), badge: { label: t('detail.receipt.started'), tone: 'info' }, fields: [{ label: t('detail.field.type'), value: match[3] }], code: { text: match[4] } }], match[2] ?? match[1], t)
    }
    case 'terminal_read': {
      const match = /\n\[lines: (\d+)-(\d+) of (\d+)\](\n\[output truncated\])?$/u.exec(text)
      if (match === null) return null
      return detailList([{ title: target, subtitle: t('detail.output.lines', { begin: match[1] ?? '', end: match[2] ?? '', total: match[3] ?? '' }), fields: [], code: { text: text.slice(0, match.index) }, ...(match[4] === undefined ? {} : { description: t('detail.output.truncated') }) }], target, t)
    }
    case 'terminal_signal': {
      const match = /^delivered (\S+) to foreground process group (\d+)$/u.exec(text)
      if (match === null || match[1] === undefined || match[2] === undefined) return null
      return receipt(target, { label: t('detail.receipt.signal'), tone: 'success' }, t, [{ label: t('detail.field.signal'), value: match[1] }, { label: t('detail.field.processGroup'), value: match[2] }])
    }
    case 'terminal_close':
      if (text === `closed terminal session ${target}`) return receipt(target, { label: t('detail.receipt.closed'), tone: 'neutral' }, t)
      if (text === `terminal session ${target} was already closing`) return receipt(target, { label: t('detail.receipt.closing'), tone: 'neutral' }, t)
      return null
    default: return null
  }
}
