import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { forgeChangeRequestsProjection } from '../src/projection.ts'
import type { ForgeChangeRequestsState } from '../src/index.ts'
import { pullUrl, pushOutput, shellTurn } from './fixtures.ts'

const { apply, init, stateSchema } = forgeChangeRequestsProjection

function fold(session: Session): ForgeChangeRequestsState {
  return session.snapshotEvents().reduce<ForgeChangeRequestsState>(
    (state, event) => apply(state, event),
    init(),
  )
}

function created(number: number): string {
  return `${pullUrl(number)}\n[stderr]\nCreating pull request for feat into main in octo/demo\n`
}

describe('forgeChangeRequests projection', () => {
  it('shows clients every binding, hidden ones included, and keeps that view while only pending calls and pushes change', () => {
    const session = Session.create(SessionId('client-view'))
    const { view, viewSchema } = forgeChangeRequestsProjection.wire
    shellTurn(session, [{ callId: 'create', command: 'gh pr create --fill', output: created(1) }])
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'track', url: pullUrl(2) })
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'dismiss', url: pullUrl(2) })
    const bound = fold(session)
    const seen = session.snapshotEvents().length
    shellTurn(session, [{ callId: 'push', command: 'git push -u origin feat', output: pushOutput('feat') }])
    // Folding only the new events on the earlier state mirrors the live drive, which compares views by reference.
    const pushed = session.snapshotEvents().slice(seen).reduce((state, event) => apply(state, event), bound)

    expect(view(bound)).toEqual([
      { url: pullUrl(1), origin: 'created', dismissed: false },
      { url: pullUrl(2), origin: 'tracked', dismissed: true },
    ])
    expect(viewSchema.parse(view(bound))).toEqual(view(bound))
    expect(pushed.pushes).not.toBe(bound.pushes)
    expect(view(pushed)).toBe(view(bound))
  })

  it('starts empty and keeps the state reference for unrelated events', () => {
    const session = Session.create(SessionId('unrelated'))
    shellTurn(session, [
      { callId: 'list', command: 'ls', output: 'README.md' },
      { callId: 'read', command: 'gh pr create', output: created(1), tool: 'read' },
    ])
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'bogus', url: pullUrl(2) } as never)
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'track', url: 'not a url' })

    const state = fold(session)

    expect(state).toEqual({ pending: [], bindings: [], pushes: [] })
    for (const event of session.snapshotEvents()) expect(apply(state, event)).toBe(state)
  })

  it('binds every pull request URL a create result prints, once', () => {
    const session = Session.create(SessionId('create'))
    shellTurn(session, [{ callId: 'create', command: 'gh pr create --fill', output: `${created(1)}${pullUrl(1)}/files\n${pullUrl(2)}` }])
    shellTurn(session, [{ callId: 'again', command: 'gh pr create --fill', output: created(1).replace('https', 'http') }])

    expect(fold(session).bindings).toEqual([
      { url: pullUrl(1), origin: 'created', dismissed: false },
      { url: pullUrl(2), origin: 'created', dismissed: false },
    ])
  })

  it('binds from pwsh calls and from results with a nonzero exit marker', () => {
    const session = Session.create(SessionId('pwsh'))
    shellTurn(session, [{
      callId: 'exists',
      command: 'gh pr create --fill',
      output: `[stderr]\na pull request for branch "feat" into branch "main" already exists:\n${pullUrl(4)}\n[exit code: 1]`,
      tool: 'pwsh',
    }])

    expect(fold(session).bindings).toEqual([{ url: pullUrl(4), origin: 'created', dismissed: false }])
  })

  it('binds nothing from failed tool executions or from output of other commands', () => {
    const session = Session.create(SessionId('failed'))
    shellTurn(session, [
      { callId: 'failed', command: 'gh pr create --fill', output: created(1), isError: true },
      { callId: 'list', command: 'gh pr list --json url', output: pullUrl(2) },
    ])

    expect(fold(session)).toEqual({ pending: [], bindings: [], pushes: [] })
  })

  it('reads evidence only from text blocks and ignores shell calls without a command', () => {
    const session = Session.create(SessionId('blocks'))
    shellTurn(session, [{ callId: 'create', command: 'gh pr create --fill', output: 'placeholder' }])
    const events = session.snapshotEvents()
    const index = events.findIndex(event => event.type === 'tool/result')
    const result = events[index]
    const call = events.find(event => event.type === 'tool/call')
    if (result?.type !== 'tool/result' || call?.type !== 'tool/call') throw new Error('missing shell call')
    const empty = init()
    const before = events.slice(0, index).reduce<ForgeChangeRequestsState>((state, event) => apply(state, event), empty)
    const mixed = {
      ...result,
      data: {
        ...result.data,
        message: createToolResultMessage({
          callId: ToolCallId('create'),
          content: [{ type: 'reasoning', text: pullUrl(9) }, { type: 'text', text: pullUrl(6) }],
          isError: false,
        }),
      },
    }

    expect(apply(before, mixed).bindings).toEqual([{ url: pullUrl(6), origin: 'created', dismissed: false }])
    expect(apply(empty, { ...call, data: { ...call.data, arguments: '{"cmd":"gh pr create"}' } })).toBe(empty)
  })

  it('records pushed branches with the reporting result sequence number and moves a repeated push last', () => {
    const session = Session.create(SessionId('push'))
    shellTurn(session, [{ callId: 'one', command: 'git push -u origin feat', output: pushOutput('feat') }])
    shellTurn(session, [{ callId: 'two', command: 'git push -u origin other', output: pushOutput('other') }])
    shellTurn(session, [{ callId: 'three', command: 'git push', output: pushOutput('feat') }])
    const results = session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.seq)

    expect(fold(session).pushes).toEqual([
      { remote: 'fake.test:octo/demo.git', branch: 'other', seq: results[1] },
      { remote: 'fake.test:octo/demo.git', branch: 'feat', seq: results[2] },
    ])
  })

  it('reads both kinds of evidence from one command and nothing from push output of a create command', () => {
    const session = Session.create(SessionId('both'))
    shellTurn(session, [
      { callId: 'both', command: 'git push -u origin feat && gh pr create --fill', output: `${pushOutput('feat')}\n${pullUrl(3)}` },
      { callId: 'create', command: 'gh pr create --fill', output: pushOutput('ignored') },
      { callId: 'push', command: 'git push', output: pullUrl(9) },
    ])
    const state = fold(session)

    expect(state.bindings).toEqual([{ url: pullUrl(3), origin: 'created', dismissed: false }])
    expect(state.pushes.map(push => push.branch)).toEqual(['feat'])
  })

  it('binds the change request a view, edit, or checkout names or prints as its own, and no other links', () => {
    const session = Session.create(SessionId('referenced'))
    shellTurn(session, [
      { callId: 'view', command: 'gh pr view 7', output: ['title:\tAdd it', `url:\t${pullUrl(7)}`, '--', `Stacked on ${pullUrl(8)}`].join('\n') },
      { callId: 'json', command: 'gh pr view 6 --json number,url,body', output: JSON.stringify({ number: 6, url: pullUrl(6), body: `see ${pullUrl(8)}` }) },
      { callId: 'checkout', command: `gh pr checkout ${pullUrl(5)}`, output: "Switched to branch 'feat'" },
      { callId: 'edit', command: 'gh pr edit 4 --add-label bug', output: `${pullUrl(4)}\n` },
    ])

    expect(fold(session).bindings).toEqual([
      { url: pullUrl(7), origin: 'referenced', dismissed: false },
      { url: pullUrl(6), origin: 'referenced', dismissed: false },
      { url: pullUrl(5), origin: 'referenced', dismissed: false },
      { url: pullUrl(4), origin: 'referenced', dismissed: false },
    ])
  })

  it('keeps a dismissed change request hidden from later references, binds as created alongside a create, and binds nothing from a failed execution', () => {
    const session = Session.create(SessionId('referenced-rules'))
    shellTurn(session, [{ callId: 'view', command: `gh pr view ${pullUrl(1)}`, output: `url:\t${pullUrl(1)}` }])
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'dismiss', url: pullUrl(1) })
    shellTurn(session, [
      { callId: 'again', command: `gh pr view ${pullUrl(1)}`, output: `url:\t${pullUrl(1)}` },
      { callId: 'both', command: `gh pr create --fill && gh pr view ${pullUrl(2)}`, output: `${pullUrl(2)}\n${pullUrl(3)}` },
      { callId: 'failed', command: `gh pr checkout ${pullUrl(9)}`, output: 'boom', isError: true },
    ])

    expect(fold(session).bindings).toEqual([
      { url: pullUrl(1), origin: 'referenced', dismissed: true },
      { url: pullUrl(2), origin: 'created', dismissed: false },
      { url: pullUrl(3), origin: 'created', dismissed: false },
    ])
  })

  it('binds a numbered PR in an explicit host repository when JSON omits the URL', () => {
    const session = Session.create(SessionId('numbered-reference'))
    shellTurn(session, [{
      callId: 'view',
      command: 'gh pr view 5960 --repo fake.test/octo/demo --json number,title,body 2>&1 | head -200',
      output: JSON.stringify({ number: 5960, title: 'Change', body: 'See #5961' }),
    }])
    expect(fold(session).bindings).toEqual([{ url: pullUrl(5960), origin: 'referenced', dismissed: false }])
  })

  it('folds only the first result of a call and drops calls without results at turn end', () => {
    const session = Session.create(SessionId('pending'))
    shellTurn(session, [{ callId: 'create', command: 'gh pr create --fill', output: created(1) }])
    const result = session.snapshotEvents().find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('missing result')
    const replayed = {
      ...result,
      seq: SessionSeq(result.seq + 100),
      data: { ...result.data, message: createToolResultMessage({ callId: ToolCallId('create'), content: [{ type: 'text', text: pullUrl(2) }], isError: false }) },
    }
    const state = fold(session)
    expect(apply(state, replayed)).toBe(state)

    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', {
      turn: 2,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('orphan'), name: 'bash', arguments: '{"command":"git push"}' }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('orphan'), name: 'bash', arguments: '{"command":"git push"}' })
    const open = fold(session)
    expect(open.pending).toEqual([{ callId: 'orphan', urls: null, pushes: true, named: [] }])

    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const [stepEnd, turnEnd] = session.snapshotEvents().slice(-2)
    if (stepEnd === undefined || turnEnd === undefined) throw new Error('missing turn end')
    const closed = apply(apply(open, stepEnd), turnEnd)
    expect(closed.pending).toEqual([])
    expect(closed.bindings).toBe(open.bindings)
    expect(closed.pushes).toBe(open.pushes)
  })

  it('applies discover, track, and dismiss records by URL identity', () => {
    const session = Session.create(SessionId('records'))
    shellTurn(session, [{ callId: 'create', command: 'gh pr create --fill', output: created(1) }])
    const record = (action: 'track' | 'dismiss' | 'discover', url: string) => {
      appendPluginRecord(session, 'plugin:forge-session/binding', { action, url })
      return fold(session)
    }

    const discovered = record('discover', pullUrl(2))
    expect(record('discover', pullUrl(2).toUpperCase().replace('HTTPS', 'https'))).toEqual(discovered)
    expect(record('track', pullUrl(1))).toEqual(discovered)
    expect(record('dismiss', `${pullUrl(1)}/`).bindings[0]).toEqual({ url: pullUrl(1), origin: 'created', dismissed: true })
    expect(record('dismiss', pullUrl(1)).bindings[0]?.dismissed).toBe(true)
    expect(record('discover', pullUrl(1)).bindings[0]?.dismissed).toBe(true)
    expect(record('track', pullUrl(1)).bindings[0]).toEqual({ url: pullUrl(1), origin: 'created', dismissed: false })
    expect(record('dismiss', pullUrl(7)).bindings).toHaveLength(2)
    expect(record('track', pullUrl(5)).bindings).toEqual([
      { url: pullUrl(1), origin: 'created', dismissed: false },
      { url: pullUrl(2), origin: 'discovered', dismissed: false },
      { url: pullUrl(5), origin: 'tracked', dismissed: false },
    ])
  })

  it('round-trips state through JSON and rejects malformed state', () => {
    const session = Session.create(SessionId('schema'))
    shellTurn(session, [{ callId: 'push', command: 'git push', output: pushOutput('feat') }])
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'track', url: pullUrl(1) })
    const state = fold(session)

    expect(stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(() => stateSchema.parse({ ...state, pushes: [{ remote: 'r', branch: 'b', seq: -1 }] })).toThrow()
    expect(() => stateSchema.parse({ ...state, extra: true })).toThrow()
  })

  it('replays confirmed references without restoring hidden bindings or changing their first origin', () => {
    const session = Session.create(SessionId('confirmed-reference'))
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'reference', url: pullUrl(9) })
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'dismiss', url: pullUrl(9) })
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'reference', url: pullUrl(9) })
    expect(fold(session).bindings).toEqual([{ url: pullUrl(9), origin: 'referenced', dismissed: true }])
  })
})
