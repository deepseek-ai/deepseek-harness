// @vitest-environment jsdom
/** Detail adapters accept the exact recorded result text and retain safe fallback paths. */
import { describe, expect, it } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en, zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { statusLine } from '@deepseek-ai/dsh-tool-jobs/src/render.ts'
import { presentation } from '@deepseek-ai/dsh-tool-session-query/src/presentation.ts'
import { renderList, renderRead, renderSpawn } from '@deepseek-ai/dsh-tool-terminal/src/render.ts'
import { formatSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import { detailBadge, detailJson, detailList, detailRecord, inspectionItems, nonempty } from '../src/client/tool/models/detail-model-shared.ts'
import { detailsCardModel } from '../src/client/tool/models/details-card-model.ts'
import type { SpillLocator } from '@deepseek-ai/dsh-spill'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'

const t = makeTranslate(en, commonEn)

function output(name: string, text: string, args: Record<string, unknown> = {}): ToolResultNode {
  return {
    kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId: `${name}-1`,
    name, args: PartialArguments.fromText(JSON.stringify(args)),
    call: { name, argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text }], isError: false, subCalls: [],
  }
}

function details(name: string, text: string, args: Record<string, unknown> = {}) {
  return detailsCardModel(output(name, text, args), t, 'en')
}

describe('shared detail values', () => {
  it('narrows JSON, localizes status, and renders scalar and nested records', () => {
    expect(detailJson('{"ok":true}')).toEqual({ ok: true })
    expect(detailJson('{')).toBeUndefined()
    expect(detailRecord({})).toBe(true)
    expect(detailRecord([])).toBe(false)
    expect(nonempty(' text ')).toBe(true)
    expect(nonempty('  ')).toBe(false)
    expect(detailBadge('completed', t)).toEqual({ label: 'Completed', tone: 'success' })
    expect(detailBadge('unknown', t)).toEqual({ label: 'unknown', tone: 'neutral' })
    expect(inspectionItems([null, true, 'x', []], t)).toHaveLength(4)
    expect(inspectionItems({ title: 'Record', description: 'Description', status: 'running', inputSchema: { type: 'object' }, arguments: '{"x":1}', empty: [], count: 2 }, t)[0]).toMatchObject({
      title: 'Record', description: 'Description', badge: { label: 'Running' },
    })
    expect(detailList([], 'none', t)).toMatchObject({ summary: 'none', caption: 'Recorded result', empty: 'No results' })
  })

  it('limits nested inspection records and preserves large values as JSON code', () => {
    const values = Array.from({ length: 41 }, (_, index) => ({ id: String(index) }))
    expect(inspectionItems(values, t)).toHaveLength(41)
    expect(inspectionItems({ nested: { deeper: { value: { more: { still: { data: true } } } } } }, t)[0]?.groups).toBeTruthy()
  })
})

describe('control detail adapters', () => {
  it('localizes unreadable catalog statuses in English and Chinese', () => {
    const states = ['corrupt', 'unsupported', 'unavailable']
    for (const [dictionary, common, locale, labels] of [
      [en, commonEn, 'en', ['Corrupt', 'Unsupported', 'Unavailable']],
      [zh, commonZh, 'zh-CN', ['已损坏', '不支持', '不可用']],
    ] as const) {
      const translate = makeTranslate(dictionary, common)
      const result = states.map(status => ({ name: status, status }))
      expect(detailsCardModel(output('list_agents', JSON.stringify(result)), translate, locale)
        ?.items.map(item => item.badge?.label)).toEqual(labels)
    }
  })

  it('localizes Team owners while preserving inspection owner fields', () => {
    const translate = makeTranslate(zh, commonZh)
    for (const tool of ['team_task_get', 'team_task_create', 'team_task_update', 'team_task_list']) {
      const task = { subject: 'Review', owner: 'reviewer/checker' }
      const value = tool === 'team_task_list' ? { tasks: [task] } : task
      expect(detailsCardModel(output(tool, JSON.stringify(value)), translate, 'zh-CN')?.items[0]?.fields)
        .toContainEqual({ label: '负责人', value: 'reviewer/checker' })
    }
    expect(inspectionItems({ owner: 'client-ui-tool' }, translate)[0]?.fields)
      .toEqual([{ label: 'owner', value: 'client-ui-tool' }])
  })

  it.each([
    [{ timedOut: false }, '等待已结束'],
    [{ timedOut: true }, '等待已超时'],
    [{ timedOut: false, noProgress: { message: 'No pending work' } }, '没有正在运行的子智能体'],
  ] as const)('renders inbox wait results and historical activity diagnostics (%j)', (value, summary) => {
    const translate = makeTranslate(zh, commonZh)
    expect(translate('tool.title.waitAgent')).toBe('等待消息…')
    expect(detailsCardModel(output('wait_agent', JSON.stringify(value)), translate, 'zh-CN')?.summary).toBe(summary)
  })

  it('uses producer wording for agent, job, terminal, and LSP lists', () => {
    const agents = details('list_agents', 'lead [running] — root agent\nreviewer/checker [inactive] — Check tests\nold-id [unavailable]')
    expect(agents?.summary).toBe('3 agents')
    expect(agents?.items).toEqual([
      { title: 'root agent', subtitle: 'lead', badge: { label: 'Running', tone: 'info' }, fields: [] },
      { title: 'Check tests', subtitle: 'reviewer/checker', badge: { label: 'Inactive', tone: 'warning' }, fields: [] },
      { title: 'old-id', badge: { label: 'Unavailable', tone: 'neutral' }, fields: [] },
    ])
    const historical = details('list_agents', 'a1 [running] — Build\na2 [ready] parent=a1 depth=1 — Review\na3 [diagnostic: corrupt] parent=a1 depth=1', { scope: 'descendants' })
    expect(historical?.summary).toBe('3 agents')
    expect(historical?.items).toEqual([
      { title: 'Build', subtitle: 'a1', badge: { label: 'Running', tone: 'info' }, fields: [] },
      { title: 'Review', subtitle: 'a2', badge: { label: 'Ready', tone: 'neutral' }, fields: [] },
      { title: 'a3', badge: { label: 'diagnostic: corrupt', tone: 'neutral' }, fields: [] },
    ])
    const structured = details('list_agents', JSON.stringify([{ name: 'lead', status: 'running', description: 'root agent' }, { name: 'reviewer', status: 'inactive' }]))
    expect(structured?.items).toEqual([
      { title: 'root agent', subtitle: 'lead', badge: { label: 'Running', tone: 'info' }, fields: [] },
      { title: 'reviewer', badge: { label: 'Inactive', tone: 'warning' }, fields: [] },
    ])
    expect(details('list_agents', 'reviewer running')).toBeNull()
    expect(details('list_agents', '(no subagents)')?.empty).toBe('No results')
    expect(details('job_list', 'j1 [bash] running — Build')?.items[0]?.fields).toContainEqual({ label: 'Type', value: 'bash' })
    expect(details('job_list', '(no background jobs)')?.empty).toBe('No results')
    expect(details('terminal_list', renderList([], 1000))?.empty).toBe('No results')
    const terminals = [
      { sessionId: 'pty-1' as never, type: 'shell', status: { kind: 'running' as const } },
      { sessionId: 'pty-2' as never, name: 'done', type: 'shell', pid: 4, status: { kind: 'exited' as const, exitCode: 2, signal: null } },
    ]
    expect(details('terminal_list', renderList(terminals, 1000))?.items).toHaveLength(2)
    const locations = details('lsp', 'src/a.ts:2:3\nhttps://example.test/a.ts:4:5\nuntitled:Untitled-1:6:7\nC:\\src\\a.ts:8:9\nD:/lib/a.ts:10:11', { file_path: 'src/main.ts', line: 2, character: 3, operation: 'findReferences' })?.items
    expect(locations?.map(item => item.location)).toEqual([
      { path: 'src/a.ts', line: 2 }, undefined, undefined, { path: 'C:\\src\\a.ts', line: 8 }, { path: 'D:/lib/a.ts', line: 10 },
    ])
    expect(details('lsp', 'No results.', { file_path: 'src/main.ts', line: 2, character: 3, operation: 'findReferences' })?.empty).toBe('No results')
    expect(details('lsp', 'hover text', { file_path: 'src/main.ts', line: 2, character: 3, operation: 'hover' })?.items[0]?.markdown).toBe('hover text')
  })

  it.each(['subagent', 'subagent_fork'])('%s recognizes ID creation receipts and retains the complete task', (name) => {
    const prompt = 'Research CLI agent products.\nCompare business models and write a report.'
    const model = details(name, 'started subagent child-1', { description: 'Research CLI agent products', prompt })
    expect(model?.summary).toBe('Research CLI agent products')
    expect(model?.items[0]).toEqual({
      title: 'Started',
      fields: [{ label: 'Agent task description', value: 'Research CLI agent products' }, { label: 'ID', value: 'child-1' }],
      groups: [{ label: 'Task', items: [{ description: prompt, fields: [] }] }],
    })
    expect(details(name, 'started subagent child-1', { prompt })?.items[0]?.title).toBe('Started')
    expect(details(name, 'started subagent child-1\nAdditional reply', { prompt })?.items[0]?.title).toBe('Agent response')
  })

  it.each(['subagent', 'subagent_fork'])('%s renders persisted creation metadata independently of result wording', (name) => {
    const args = { description: 'Review the changes', prompt: 'Read the diff and report defects.' }
    const block = { ...output(name, 'Delegation accepted.', args), meta: { kind: 'activation', name: 'reviewer' } }
    const model = detailsCardModel(block, t, 'en')
    expect(model?.items[0]).toEqual({
      title: 'Started',
      fields: [
        { label: 'Agent task description', value: args.description },
        { label: 'Agent name', value: 'reviewer' },
      ],
      groups: [{ label: 'Task', items: [{ description: args.prompt, fields: [] }] }],
    })
    expect(detailsCardModel({ ...block, content: [] }, t, 'en')).toEqual(model)
    expect(detailsCardModel({ ...block, isError: true }, t, 'en')).toBeNull()
    expect(detailsCardModel(block, makeTranslate(zh, commonZh), 'zh-CN')?.items[0]?.fields).toEqual([
      { label: '智能体任务描述', value: args.description },
      { label: '智能体名称', value: 'reviewer' },
    ])
  })

  it('omits the name from metadata recorded before agents had names', () => {
    const args = { description: 'Review the changes', prompt: 'Read the diff and report defects.' }
    const block = { ...output('subagent', 'started subagent child-1', args), meta: { kind: 'activation', subagentId: 'child-1' } }
    expect(detailsCardModel(block, t, 'en')?.items[0]?.fields).toEqual([
      { label: 'Agent task description', value: args.description }, { label: 'ID', value: 'child-1' },
    ])
  })

  it.each([
    null, [], {}, { kind: 'other', subagentId: 'child-1' }, { kind: 'activation' }, { kind: 'activation', subagentId: 1 },
    { kind: 'activation', subagentId: ' ' }, { kind: 'activation', subagentId: 'child-1', name: 1 },
    { kind: 'activation', subagentId: 'child-1', name: ' ' },
  ])(
    'keeps malformed metadata on the generic result path (%j)', (meta) => {
      const block = { ...output('subagent', 'started subagent child-1'), meta }
      expect(detailsCardModel(block, t, 'en')).toBeNull()
    },
  )

  it('renders receipts, reports malformed formats, and handles truncation', () => {
    expect(details('spawn_teammate', '{"member":{"id":"a1","status":"running"}}', { name: 'A' })?.items[0]).toMatchObject({ title: 'a1', badge: { label: 'Running' } })
    expect(details('team_task_create', '{"id":"task-1","subject":"Review","status":"pending"}')?.summary).toBe('Review')
    expect(details('team_task_list', '{"tasks":[{"id":"task-1","subject":"Review"}],"nextCursor":3}')?.caption).toBe('More tasks available; next cursor is 3')
    expect(details('team_task_get', '{"id":"task-1","subject":"Review","owner":"reviewer/checker"}')?.items[0]?.fields).toContainEqual({ label: 'Owner', value: 'reviewer/checker' })
    expect(details('team_task_get', '{"id":"task-1","subject":"Review","ownerId":"child-1"}')?.items[0]?.fields).toContainEqual({ label: 'Owner', value: 'child-1' })
    expect(details('send_message', '{"status":"queued"}', { agent: 'reviewer', message: 'hello' })?.items[0]).toMatchObject({ title: 'reviewer', badge: { label: 'Queued' } })
    expect(details('send_message', 'message delivered to agent reviewer/checker', { agent: 'reviewer/checker', message: 'hello' })?.summary).toBe('reviewer/checker · Message delivered')
    expect(details('send_message', 'message delivered to agent reviewer', { agent_id: 'reviewer', message: 'hello' })?.summary).toBe('reviewer · Message delivered')
    expect(details('interrupt_agent', '{"previousStatus":"running"}', { agent_id: 'a1' })?.items[0]?.fields).toContainEqual({ label: 'Previous status', value: 'Running' })
    expect(details('wait_agent', '{"timedOut":true}')?.summary).toBe('Wait timed out')
    expect(details('wait_agent', '{"timedOut":false,"noProgress":{"message":"No peer"}}')?.items[0]?.description).toBe('No peer')
    expect(details('subagent', 'started background subagent job job-1', { prompt: 'Do work' })?.items[0]?.fields).toContainEqual({ label: 'Job ID', value: 'job-1' })
    expect(details('subagent', 'A useful reply', { prompt: 'Do work' })?.items[0]?.markdown).toBe('A useful reply')
    expect(details('list_subagent_models', 'deepseek-chat — Fast\nunknown', { model: 'deepseek-chat' })?.items).toHaveLength(2)
    expect(details('job_kill', 'requested cancellation of job j1', { job_id: 'j1', reason: 'stop' })?.summary).toContain('Cancellation requested')
    expect(details('job_kill', 'job j1 had already finished completed', { job_id: 'j1' })?.summary).toContain('Already finished')
    const spawnText = renderSpawn({ sessionId: 'pty-1', type: 'shell', status: { kind: 'running' }, motd: 'ready' }, 1000)
    expect(details('terminal_open', spawnText)?.items[0]?.code?.text).toBe('ready')
    const readText = renderRead({ text: 'line', totalLines: 2, lineBegin: 0, lineEnd: 1, truncated: true }, 1000)
    expect(details('terminal_read', readText, { sessionId: 'pty-1' })?.items[0]?.description).toBe('Output truncated')
    expect(details('terminal_signal', 'delivered SIGINT to foreground process group 12', { sessionId: 'pty-1' })?.items[0]?.fields).toContainEqual({ label: 'Process group', value: '12' })
    expect(details('terminal_close', 'closed terminal session pty-1', { sessionId: 'pty-1' })?.summary).toContain('Closed')
    expect(details('terminal_close', 'terminal session pty-1 was already closing', { sessionId: 'pty-1' })?.summary).toContain('Closing')
    expect(details('job_output', `hello\n[output truncated]\n${statusLine({ status: 'completed' })}`, { job_id: 'j1' })?.items[0]).toMatchObject({ code: { text: 'hello' }, description: 'Output truncated' })
    expect(details('job_output', `hello\n${statusLine({ status: 'completed', detail: 'exit code: 0' })}`, { job_id: 'j1' })?.items[0]?.description).toBe('exit code: 0')
    expect(details('unknown', 'x')).toBeNull()
    expect(details('team_task_list', '{"tasks":[],"nextCursor":"bad"}')).toBeNull()
    expect(details('terminal_read', 'bad', { sessionId: 'pty-1' })).toBeNull()
    expect(details('interrupt_agent', 'interrupt requested for agent reviewer', { agent: 'reviewer' })?.summary).toBe('reviewer · Interrupt requested')
    expect(details('interrupt_agent', 'interrupt requested for agent reviewer', { agent_id: 'reviewer' })?.summary).toContain('Interrupt')
    expect(details('interrupt_agent', 'unexpected', { agent_id: 'a1' })).toBeNull()
    expect(details('job_kill', 'unexpected', { job_id: 'j1' })).toBeNull()
    expect(details('terminal_close', 'unexpected', { sessionId: 'pty-1' })).toBeNull()
  })
})

describe('inspection detail adapters', () => {
  const sessionRecord = (id: string, live: boolean, persisted: boolean) => ({
    header: { id: id as never, createdAt: 1_000, parentSession: undefined }, live, persisted,
  })

  it('accepts Cordis, workflow, and Ralph producer results', () => {
    expect(details('cordis_inspect_list', '{"providers":[{"name":"Service","status":"ready"}]}')?.summary).toBe('1 inspect providers')
    expect(details('cordis_inspect_query', '{"provider":"Service","method":"get","data":{"value":1}}')?.summary).toBe('Service.get')
    expect(details('cordis_inspect_self', '{"mode":"client","plugins":[]}')?.summary).toBe('0 dynamic plugins')
    expect(details('cordis_inspect_self', '{"mode":"host","packageId":"pkg","value":1}')?.summary).toBe('host')
    expect(details('cordis_inspect_self', '{"mode":"host","value":1}', { pluginId: 'plugin-1' })?.summary).toBe('plugin-1')
    expect(details('workflow', 'workflow "flow" completed (1 agent).\nReturn value:\n{"ok":true}', { code: 'return true' })?.items[0]?.fields).toContainEqual({ label: 'Agents started', value: '1' })
    const report = JSON.stringify({ summary: 'Done', evidence: ['checked'], nextSteps: ['ship'], blocker: '' }, null, 2)
    expect(details('ralph', `Ralph worker reported completion after 2 rounds.\nFinal report:\n${report}`, { objective: 'Ship' })?.items[0]).toMatchObject({ title: 'Done', lines: ['checked'] })
    expect(details('ralph', `Ralph worker reported a blocker after 1 round.\nFinal report:\n${JSON.stringify({ summary: 'Blocked', evidence: [], nextSteps: [], blocker: 'No key' })}`)?.items[0]?.badge?.label).toBe('Worker reported a blocker')
    expect(details('ralph', `Ralph reached its 3 rounds limit; the worker reported work remaining.\nFinal report:\n${JSON.stringify({ summary: 'Limited', evidence: [], nextSteps: [], blocker: '' })}`)?.items[0]?.badge?.label).toBe('Round limit reached')
  })

  it('uses the session-query producer presentation for searches, reads, and traces', () => {
    const session = sessionRecord('s1', true, true)
    const hit = { ...session, bestMatch: { sessionId: 's1' as never, seq: 2, type: 'user/message', time: 2_000, surface: 'current', snippet: 'needle' } }
    const title = { text: 'Session one' }
    const titles = new Map([
      ['s1' as never, title], ['s2' as never, { text: 'Child' }], ['s3' as never, { text: 'Grandchild' }],
    ]) as Parameters<typeof presentation.formatSessionSearch>[1]
    const sessionSearch = presentation.formatSessionSearch({ items: [hit as never], capped: true }, titles, new Set())
    expect(details('session_search', sessionSearch)?.items[0]).toMatchObject({ title: 'Session one', subtitle: 's1', description: 'needle' })
    const eventSearch = presentation.formatEventSearch(
      's1' as never, title,
      { items: [{ sessionId: 's1' as never, seq: 2 as never, type: 'tool/call', time: 2_000, surface: 'current', snippet: 'needle' }], capped: false },
    )
    expect(details('session_event_search', eventSearch)?.items[0]?.title).toBe('needle')
    const trace = presentation.formatSessionTrace(
      { target: session as never, ancestors: [], descendants: [], complete: true, root: session as never } as never,
      [], false, [{ record: sessionRecord('s2', true, true) as never, descendants: [{ record: sessionRecord('s3', true, true) as never, descendants: [] }] }], titles,
    )
    const traceItems = details('session_trace', trace)?.items
    expect(traceItems).toHaveLength(3)
    expect(traceItems?.[0]).toMatchObject({ title: 'Session one', subtitle: 's1' })
    expect(traceItems?.[2]?.lines).toEqual([
      's2 — Child | 1970-01-01T00:00:01.000Z | live, persisted',
      '  s3 — Grandchild | 1970-01-01T00:00:01.000Z | live, persisted',
    ])
    const eventTrace = presentation.formatEventTrace(
      's1' as never, title,
      {
        session: { id: 's1' as never, createdAt: 1_000 } as never,
        target: { sessionId: 's1' as never, seq: 2 as never, type: 'tool/call', time: 2_000, surface: 'current' },
        replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [], derivedEventSeqs: [],
      },
    )
    expect(details('session_event_trace', eventTrace)?.items[0]?.fields).toContainEqual({ label: 'Target event', value: 'seq 2 | tool/call | current | 1970-01-01T00:00:02.000Z' })
    const event = { seq: 2, time: 2_000, type: 'tool/call', data: { name: 'x' } }
    const eventRead = presentation.formatEventRead(
      's1' as never, title,
      {
        session: {} as never, inheritedEventCount: 0 as never, target: event as never,
        events: [event as never], startSeq: 2 as never, endSeq: 2 as never,
      },
    )
    expect(details('session_event_read', eventRead)?.items[0]?.title).toBe('tool/call')
    expect(details('session_search', 'No prior session matches found.')?.summary).toBe('0 matches')
    expect(details('session_event_search', 'Session s1 — Session one\n\nNo prior event matches found.')?.summary).toBe('0 matches')
  })

  it('retains generic output for malformed or spilled inspection results', () => {
    expect(details('workflow', 'bad')).toBeNull()
    expect(details('session_trace', 'Session s1 — title\nCreated: invalid\nAvailability: unavailable\n\nAncestors (nearest first):\n- none (target is a root session)\n\nDescendants:\n- none')?.items[0]?.fields).toContainEqual({ label: 'Time', value: 'invalid' })
    const notice = formatSpillNotice({ kind: 'exact', count: 100 }, { locator: brandString<SpillLocator>('/tmp/result.txt'), retrievalHint: 'Read it with read' })
    expect(details('session_event_trace', `Session s1 — title\nCreated: 1970-01-01T00:00:00.000Z\n\n${notice}`)).toBeNull()
    expect(details('session_search', 'not a result')).toBeNull()
    expect(details('session_event_read', 'not a result')).toBeNull()
    expect(details('workflow', 'workflow "flow" completed (1 agent).\nReturn value:\nnot-json')).toBeNull()
    expect(details('ralph', 'Ralph worker reported completion after 1 round.\nFinal report:\nnot-json')).toBeNull()
    expect(details('ralph', 'Ralph worker reported completion after 1 round.\nFinal report:\n{"summary":"x","evidence":[1],"nextSteps":[],"blocker":""}')).toBeNull()
    expect(details('ralph', 'Ralph worker reported completion after 1 round.\nFinal report:\n{"summary":"x","evidence":[],"nextSteps":[1],"blocker":""}')).toBeNull()
    expect(details('ralph', 'Unknown result\nFinal report:\n{"summary":"x","evidence":[],"nextSteps":[],"blocker":""}')).toBeNull()
    expect(details('session_search', '1. Session s1 — title\n   Created: 2026-01-01T00:00:00.000Z')).not.toBeNull()
    expect(details('session_search', '1. Session — title')).toBeNull()
    expect(details('session_event_search', '1. seq bad | tool/call | current | 2026-01-01T00:00:00.000Z')).toBeNull()
  })
})

describe('detailsCardModel fallback contract', () => {
  it('keeps malformed successful domain results generic', () => {
    expect(detailsCardModel(output('create_goal', 'not-json'), t, 'en')).toBeNull()
    expect(detailsCardModel(output('schedule_create', '{"id":"s","prompt":"x","kind":"at","scheduledAt":"invalid","state":"scheduled","deliveryMode":"session-local"}'), t, 'en')).toBeNull()
  })

  it('keeps recorded dates readable when the document language is invalid', () => {
    const scheduledAt = '2026-09-10T09:00:00.000Z'
    const model = detailsCardModel(output('schedule_create', JSON.stringify({
      id: 'schedule-1', prompt: 'Review the build', kind: 'at', scheduledAt,
      state: 'scheduled', deliveryMode: 'session-local',
    })), t, 'en_US')
    expect(model?.items[0]?.fields).toContainEqual({ label: 'Scheduled for', value: scheduledAt })
    const trace = detailsCardModel(output('session_event_trace', 'Session s1 — title\nCreated: 1970-01-01T00:00:00.000Z'), t, 'en_US')
    expect(trace?.items[0]?.fields).toContainEqual({ label: 'Time', value: '1970-01-01T00:00:00.000Z' })
  })
})
