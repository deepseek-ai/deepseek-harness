import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { SystemMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { assembleSystemAdmission } from '../src/admission.ts'
import { sectionAdmissionsDefinition } from '../src/projection.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  const session = createSession(SessionId('sections'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const commit = async (target = session, context: AssembleContext = {}, accepted?: PromptAssembly) => {
    const assembly = accepted ?? await ctx.systemPrompt.assemble({ ...context, session: target })
    const admitted = admittedMessages(assembly)
    admit(target, assembly)
    return admitted.map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).filter(Boolean).join('\n\n'))
  }
  return { ctx, session, commit }
}

function user(session: Session, text: string) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' }).seq
}

function canonical(message: SystemMessage) {
  return message.source.sections?.filter(section => section.state === 'active').map(section => ({
    name: section.name, order: section.order, text: message.content.flatMap((block, index) => index === section.contentIndex && block.type === 'text' ? [block.text] : []).join(''),
  })) ?? []
}

function createSession(id: SessionId, seed?: readonly SessionEvent[]) {
  return Session.create(id, seed)
}

function admit(session: Session, assembly: PromptAssembly) {
  for (const { message, intent } of assembly.systemUpdates(false)) {
    session.append('system/message', { turn: 1, step: 1, message }, intent)
  }
}

function needsRebuild(session: Session) {
  return session.snapshotEvents().reduce(
    (state, event) => sectionAdmissionsDefinition.apply(state, event),
    sectionAdmissionsDefinition.init(session.header, session.inheritedEventCount),
  ).needsRebuild
}

async function rebuildCandidate(ctx: Context, session: Session): Promise<SystemMessage> {
  const compacted = Session.create(session.id, session.snapshotEvents(), session.header, session.inheritedEventCount)
  markCompaction(compacted)
  return admittedMessages((await ctx.systemPrompt.assemble({ session: compacted })))[0]!
}

function markCompaction(session: Session, start = session.surface.nodes[0] ?? SessionSeq(0), end = start) {
  session.append('compaction/summary', {
    compactionId: CompactionId('compact'), summary: [], shadowedRange: { start, end },
    shadowedSeqs: [], shadowedTokenCount: 0, provider: 'mock', model: 'mock',
  })
}

function rebuild(session: Session, message: SystemMessage) {
  const [head, ...tail] = session.surface.nodes
  for (const seq of tail) {
    if (session.eventAt(seq)!.type !== 'system/message') continue
    const empty: SystemMessage = { ...createSystemMessage(''), content: [], source: { kind: 'system-prompt', sections: [] } }
    session.append('system/message', { turn: 1, step: 1, message: empty }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    })
  }
  session.append('system/message', { turn: 1, step: 1, message }, {
    surfaceOp: { op: 'replace', startSeq: head!, endSeq: head! }, sourceEventSeqs: [head!],
  })
}

function compact(session: Session, start: SessionSeq, end: SessionSeq, snapshot: SystemMessage) {
  markCompaction(session, start, end)
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary.' }], source: { kind: 'user' } }), {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: session.surface.nodes.slice(session.surface.nodes.indexOf(start), session.surface.nodes.indexOf(end) + 1),
  })
  rebuild(session, snapshot)
}

describe('section admission', () => {
  it('keeps an empty initial head for instructions admitted and compacted later', async () => {
    const h = await harness()
    const discarded = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(admittedMessages(discarded)).toMatchObject([{ content: [] }])
    expect(h.session.surface.nodes).toEqual([])

    expect(await h.commit()).toEqual([''])
    const head = h.session.surface.nodes[0]!
    expect(h.session.eventAt(head)).toMatchObject({ type: 'system/message', data: { message: { content: [] } } })
    expect(h.session.deriveMessages()).toEqual([])
    expect(await h.commit()).toEqual([])
    const restored = createSession(SessionId('empty-head-replay'), h.session.snapshotEvents())
    expect(await h.commit(restored)).toEqual([])

    const start = user(h.session, 'Earlier conversation.')
    h.ctx.systemPrompt.section({ name: 'late', order: 1, text: 'Later instructions.' })
    expect(await h.commit()).toEqual(['Later instructions.'])
    const end = user(h.session, 'Later conversation.')
    compact(h.session, start, end, await rebuildCandidate(h.ctx, h.session))
    expect(h.session.deriveMessages().map(message => message.role)).toEqual(['system', 'user'])
    expect(h.session.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: 'Later instructions.' }])
    expect(await h.commit()).toEqual([])
  })

  it('introduces sections in order and sends only changed rendered text', async () => {
    const h = await harness()
    let directory = '/first'
    h.ctx.systemPrompt.variable('directory', () => directory)
    h.ctx.systemPrompt.section({ name: 'stable', order: 1, text: 'Stable instructions.' })
    h.ctx.systemPrompt.section({ name: 'directory', order: 2, text: 'Directory: {{directory}}', replacement: 'The directory has changed.' })
    const prepared = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(admittedMessages(prepared)[0]?.content).toEqual([
      { type: 'text', text: 'Stable instructions.' },
      { type: 'text', text: 'Directory: /first' },
    ])
    expect(admittedMessages(prepared)[0]?.source.sections).toEqual([
      { name: 'stable', order: 1, state: 'active', contentIndex: 0 },
      { name: 'directory', order: 2, state: 'active', contentIndex: 1 },
    ])
    expect(await h.commit()).toEqual(['Stable instructions.\n\nDirectory: /first'])
    expect(await h.commit()).toEqual([])
    directory = '/second'
    const changed = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(admittedMessages(changed)[0]?.content).toEqual([
      { type: 'text', text: 'The directory has changed.' },
      { type: 'text', text: 'Directory: /second' },
    ])
    expect(admittedMessages(changed)[0]?.source.sections).toEqual([
      { name: 'directory', order: 2, state: 'active', contentIndex: 1, noticeIndex: [0] },
    ])
    expect(await h.commit()).toEqual(['The directory has changed.\n\nDirectory: /second'])
    expect(await h.commit()).toEqual([])
  })

  it('attributes each source notice without including it in effective instructions', async () => {
    const h = await harness()
    let first = 'First.'
    let second = 'Second.'
    const disposeFirst = h.ctx.systemPrompt.section({
      name: 'first', order: 1, text: () => first, replacement: 'First changed.', retirement: 'First retired.',
    })
    const disposeSecond = h.ctx.systemPrompt.section({
      name: 'second', order: 2, text: () => second, replacement: 'Second changed.', retirement: 'Second retired.',
    })
    await h.commit()
    first = 'Updated first.'
    second = ''
    const changed = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(admittedMessages(changed)[0]?.content).toEqual([
      { type: 'text', text: 'First changed.' }, { type: 'text', text: 'Updated first.' },
      { type: 'text', text: 'Second changed.' }, { type: 'text', text: '' },
    ])
    expect(admittedMessages(changed)[0]?.source.sections).toEqual([
      { name: 'first', order: 1, state: 'active', contentIndex: 1, noticeIndex: [0] },
      { name: 'second', order: 2, state: 'active', contentIndex: 3, noticeIndex: [2] },
    ])
    await h.commit(h.session, {}, changed)
    const snapshot = await rebuildCandidate(h.ctx, h.session)
    expect(snapshot.content).toEqual([{ type: 'text', text: 'Updated first.' }, { type: 'text', text: '' }])
    expect(snapshot.source.sections).toEqual([
      { name: 'first', order: 1, state: 'active', contentIndex: 0 },
      { name: 'second', order: 2, state: 'active', contentIndex: 1 },
    ])
    expect(await h.commit()).toEqual([])

    disposeFirst()
    disposeSecond()
    const retired = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(admittedMessages(retired)[0]?.content).toEqual([
      { type: 'text', text: 'First retired.' }, { type: 'text', text: 'Second retired.' },
    ])
    expect(admittedMessages(retired)[0]?.source.sections).toEqual([
      { name: 'first', state: 'retired', noticeIndex: [0] },
      { name: 'second', state: 'retired', noticeIndex: [1] },
    ])
    await h.commit(h.session, {}, retired)
    expect((await rebuildCandidate(h.ctx, h.session)).content).toEqual([])
    expect(await h.commit()).toEqual([])
  })

  it.each([false, true])('trims interpolated text before admission and comparison, complete=%s', async (complete) => {
    const h = await harness()
    let text = ' \nKeep  internal\n\nspacing.\t '
    h.ctx.systemPrompt.variable('instructions', () => text)
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: '{{instructions}}', complete })
    expect(await h.commit()).toEqual(['Keep  internal\n\nspacing.'])
    text = 'Keep  internal\n\nspacing.'
    expect(await h.commit()).toEqual([])
    const replay = createSession(SessionId('trimmed-replay'), h.session.snapshotEvents())
    text = '\tKeep  internal\n\nspacing.\n'
    expect(await h.commit(replay)).toEqual([])
  })

  it('trims literal sections and notices and omits new whitespace-only sections', async () => {
    const h = await harness()
    let text = ' \n{{literal}}\t '
    let blank = '\n'
    h.ctx.systemPrompt.section({ name: 'blank', order: 0, text: () => blank })
    const leave = h.ctx.systemPrompt.section({
      name: 'literal', order: 1, text: () => text, interpolate: false,
      replacement: ' \nUpdated.\t ', retirement: ' \nRetired.\t ',
    })
    expect(await h.commit()).toEqual(['{{literal}}'])
    const beforeBlankChange = h.session.snapshotEvents()
    blank = '\n\n'
    expect(await h.commit()).toEqual([])
    expect(h.session.snapshotEvents()).toEqual(beforeBlankChange)
    text = ' changed '
    expect(await h.commit()).toEqual(['Updated.\n\nchanged'])
    leave()
    expect(await h.commit()).toEqual(['Retired.'])
  })

  it('does not advance admission when a prepared update is not committed', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Policy.' })
    const assembly = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(admittedMessages(assembly)).toHaveLength(1)
    expect(admittedMessages((await h.ctx.systemPrompt.assemble({ session: h.session })))).toHaveLength(1)
    expect(await h.commit(h.session, {}, assembly)).toEqual(['Policy.'])
    expect(admittedMessages(assembly)).toEqual([])
    expect(await h.commit()).toEqual([])
  })

  it('retires through producer disposal without calling its text callback again', async () => {
    const h = await harness()
    const render = vi.fn(() => 'Plugin instructions.')
    const producer = h.ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.section({ name: 'plugin', order: 1, text: render, retirement: 'Plugin instructions no longer apply.' })
    }, { inject: ['systemPrompt'] }))
    await producer
    expect(await h.commit()).toEqual(['Plugin instructions.'])
    await producer.dispose()
    render.mockImplementation(() => { throw new Error('disposed producer was called') })
    expect(await h.commit()).toEqual(['Plugin instructions no longer apply.'])
    expect(render).toHaveBeenCalledTimes(1)
    expect(await h.commit()).toEqual([])
    const fresh = createSession(SessionId('fresh'))
    fresh.append('turn/start', { turn: 1 })
    fresh.append('step/start', { turn: 1, step: 1 })
    expect(await h.commit(fresh)).toEqual([''])
    h.ctx.systemPrompt.section({ name: 'plugin', order: 1, text: 'Plugin instructions.' })
    expect(await h.commit()).toEqual(['Plugin instructions.'])
  })

  it.each([false, true])('coalesces retirement and reentry before admission, changed=%s', async (changed) => {
    const h = await harness()
    let text = 'Plugin instructions.'
    const plugin = Object.assign((inner: Context) => {
      inner.systemPrompt.section({ name: 'plugin', order: 1, text, retirement: 'Plugin instructions no longer apply.' })
    }, { inject: ['systemPrompt'] })
    const producer = await h.ctx.plugin(plugin)
    expect(await h.commit()).toEqual(['Plugin instructions.'])
    const history = [...h.session.snapshotEvents()]
    const messages = h.session.deriveMessages()

    await producer.dispose()
    expect((await h.ctx.systemPrompt.assemble({ session: h.session })).sections.find(section => section.name === 'plugin'))
      .toMatchObject({ retire: true, text: 'Plugin instructions no longer apply.' })
    if (changed) text = 'Updated plugin instructions.'
    await h.ctx.plugin(plugin)

    if (changed) {
      expect(await h.commit()).toEqual(['The following replaces the earlier instructions from plugin.\n\nUpdated plugin instructions.'])
      const events = h.session.snapshotEvents()
      expect(events.slice(0, history.length)).toEqual(history)
      expect(events.slice(history.length)).toMatchObject([{ type: 'system/message', surfaceOp: 'append' }])
      expect(h.session.deriveMessages().slice(0, messages.length)).toEqual(messages)
    } else {
      expect(await h.commit()).toEqual([])
      expect(h.session.snapshotEvents()).toEqual(history)
      expect(h.session.deriveMessages()).toEqual(messages)
    }
    expect(await h.commit()).toEqual([])
  })

  it.each(['', '\n', ' \n\t '])('admits blank text updates and retires once when disposed: %j', async (blank) => {
    const h = await harness()
    let text = 'Current instructions.'
    const release = h.ctx.systemPrompt.section({ name: 'plugin', order: 1, text: () => text })
    await h.commit()
    text = blank
    expect(await h.commit()).toEqual(['The earlier instructions from plugin no longer apply.'])
    const afterRetraction = h.session.snapshotEvents()
    text = '\n\n'
    expect(await h.commit()).toEqual([])
    expect(h.session.snapshotEvents()).toEqual(afterRetraction)
    text = 'Live again.'
    await h.commit()
    release()
    release()
    expect(await h.commit()).toEqual(['The earlier instructions from plugin no longer apply.'])
    expect(await h.commit()).toEqual([])
  })

  it.each([false, true])('compares inherited admissions independently with complete=%s', async (complete) => {
    const h = await harness()
    let text = 'Before.'
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text, complete })
    await h.commit()
    const inherited = createSession(SessionId('child'), h.session.snapshotEvents())
    expect(await h.commit(inherited)).toEqual([])
    text = 'After.'
    const notice = complete
      ? 'From this point onward, the following complete system prompt replaces all earlier system-prompt sections.'
      : 'The following replaces the earlier instructions from policy.'
    expect(await h.commit(inherited)).toEqual([`${notice}\n\nAfter.`])
    expect(await h.commit()).toEqual([`${notice}\n\nAfter.`])
  })

  it('shares one source definition across Sessions without sharing retirement progress', async () => {
    const h = await harness()
    const release = h.ctx.systemPrompt.section({ name: 'shared', order: 1, text: 'Shared.' })
    await h.commit()
    const second = createSession(SessionId('second'), h.session.snapshotEvents())
    await h.commit(second)
    release()
    expect(await h.commit()).toEqual(['The earlier instructions from shared no longer apply.'])
    expect(await h.commit()).toEqual([])
    expect(await h.commit(second)).toEqual(['The earlier instructions from shared no longer apply.'])
    expect(await h.commit(second)).toEqual([])
  })

  it.each([false, true])('retires a shared ID only after its visible chain is empty, parent-first=%s', async (parentFirst) => {
    const h = await harness()
    const key = {}
    let scope!: ReturnType<typeof createScope>
    await h.ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['systemPrompt'] }))
    const parent = h.ctx.systemPrompt.section({
      name: 'shared', order: 1, text: 'Parent.', replacement: 'Parent restored.', retirement: 'Parent retired.',
    })
    expect(await h.commit(h.session, { scope: key })).toEqual(['Parent.'])
    const child = scope.ctx.systemPrompt.section({
      name: 'shared', order: 2, text: 'Child.', replacement: 'Child selected.', retirement: 'Child retired.',
    })
    expect(await h.commit(h.session, { scope: key })).toEqual(['Child selected.\n\nChild.'])
    if (parentFirst) {
      parent()
      expect(await h.commit(h.session, { scope: key })).toEqual([])
      child()
      expect(await h.commit(h.session, { scope: key })).toEqual(['Child retired.'])
    } else {
      child()
      expect(await h.commit(h.session, { scope: key })).toEqual(['Parent restored.\n\nParent.'])
      parent()
      expect(await h.commit(h.session, { scope: key })).toEqual(['Parent retired.'])
    }
    expect(await h.commit(h.session, { scope: key })).toEqual([])
    const messages = h.session.snapshotEvents().filter(event => event.type === 'system/message')
    expect(messages.flatMap(event => event.data.message.source.sections ?? []).filter(section => section.state === 'retired'))
      .toEqual([{ name: 'shared', state: 'retired', noticeIndex: [0] }])
  })

  it.each([false, true])('uses the final disposed definition when all owners leave between assemblies, parent-first=%s', async (parentFirst) => {
    const h = await harness()
    const key = {}
    let scope!: ReturnType<typeof createScope>
    await h.ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['systemPrompt'] }))
    const parent = h.ctx.systemPrompt.section({ name: 'shared', order: 1, text: 'Parent.', retirement: 'Parent retired.' })
    const child = scope.ctx.systemPrompt.section({ name: 'shared', order: 1, text: 'Child.', retirement: 'Child retired.' })
    expect(await h.commit(h.session, { scope: key })).toEqual(['Child.'])
    if (parentFirst) {
      parent()
      child()
    } else {
      child()
      parent()
    }
    expect(await h.commit(h.session, { scope: key })).toEqual([parentFirst ? 'Child retired.' : 'Parent retired.'])
    expect(await h.commit(h.session, { scope: key })).toEqual([])
  })

  it('discards transient overrides while preserving accepted candidates and inherited text', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'shared', order: 1, text: 'Parent.' })
    await h.commit()
    const unchanged = h.ctx.systemPrompt.section({ name: 'shared', order: 1, text: '  Parent.  ' })
    expect(await h.commit()).toEqual([])
    unchanged()
    const rejected = h.ctx.systemPrompt.section({ name: 'shared', order: 1, text: 'Rejected.' })
    expect(admittedMessages((await h.ctx.systemPrompt.assemble({ session: h.session })))).toHaveLength(1)
    rejected()
    expect(await h.commit()).toEqual([])
    const release = h.ctx.systemPrompt.section({ name: 'shared', order: 1, text: 'Accepted.' })
    const accepted = await h.ctx.systemPrompt.assemble({ session: h.session })
    release()
    expect(await h.commit(h.session, {}, accepted)).toEqual(['The following replaces the earlier instructions from shared.\n\nAccepted.'])
    expect(await h.commit()).toEqual(['The following replaces the earlier instructions from shared.\n\nParent.'])
  })

  it('resolves shared definitions separately for each Session and excludes sibling overrides', async () => {
    const h = await harness()
    const key = {}
    let scope!: ReturnType<typeof createScope>
    await h.ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['systemPrompt'] }))
    const other = createSession(SessionId('other-scope'))
    other.append('turn/start', { turn: 1 })
    other.append('step/start', { turn: 1, step: 1 })
    const parent = h.ctx.systemPrompt.section({ name: 'shared', order: 1, text: ({ session }) => session === h.session ? 'Parent A.' : 'Parent B.' })
    scope.ctx.systemPrompt.section({ name: 'shared', order: 1, text: 'Child A.' })
    expect(await h.commit(h.session, { scope: key })).toEqual(['Child A.'])
    expect(await h.commit(other)).toEqual(['Parent B.'])
    await scope.dispose()
    expect(await h.commit(h.session, { scope: key })).toEqual(['The following replaces the earlier instructions from shared.\n\nParent A.'])
    expect(await h.commit(other)).toEqual([])
    parent()
    expect(await h.commit(h.session, { scope: key })).toEqual(['The earlier instructions from shared no longer apply.'])
    expect(await h.commit(other)).toEqual(['The earlier instructions from shared no longer apply.'])
  })

  it('does not retire rejected candidates or sources never captured by a Session', async () => {
    const h = await harness()
    const release = h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Uncommitted.' })
    expect(admittedMessages((await h.ctx.systemPrompt.assemble({ session: h.session })))).toHaveLength(1)
    release()
    expect(await h.commit()).toEqual([''])
    const other = h.ctx.systemPrompt.section({ name: 'transient', order: 1, text: 'Unobserved.' })
    other()
    expect(await h.commit()).toEqual([])
  })

  it('keeps scoped retirements out of other scopes', async () => {
    const h = await harness()
    const key = {}
    let scope!: ReturnType<typeof createScope>
    await h.ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['systemPrompt'] }))
    scope.ctx.systemPrompt.section({ name: 'persona', order: 1, text: 'Child persona.', retirement: 'Child persona retired.' })
    expect(await h.commit(h.session, { scope: key })).toEqual(['Child persona.'])
    const other = createSession(SessionId('other-scope'))
    other.append('turn/start', { turn: 1 })
    other.append('step/start', { turn: 1, step: 1 })
    await h.commit(other)
    await scope.dispose()
    expect(await h.commit(other)).toEqual([])
    expect(await h.commit(h.session, { scope: key })).toEqual(['Child persona retired.'])
    expect(await h.commit(h.session, { scope: key })).toEqual([])
  })

  it('keeps an accepted assembly stable when its registration is disposed before admission', async () => {
    const h = await harness()
    const release = h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Accepted instructions.' })
    const accepted = await h.ctx.systemPrompt.assemble({ session: h.session })
    release()
    expect(await h.commit(h.session, {}, accepted)).toEqual(['Accepted instructions.'])
    expect(admittedMessages(accepted)).toEqual([])
    expect(await h.commit()).toEqual(['The earlier instructions from policy no longer apply.'])
  })

  it('rebuilds from uncommitted live text and clears newer suffix admissions', async () => {
    const h = await harness()
    let text = 'Before.'
    h.ctx.systemPrompt.section({ name: 'stable', order: 0, text: 'Stable.' })
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text })
    await h.commit()
    const start = user(h.session, 'First task.')
    text = 'During.'
    await h.commit()
    const end = user(h.session, 'Second task.')
    text = 'After.'
    await h.commit()
    text = 'Latest, uncommitted.'
    const snapshot = await rebuildCandidate(h.ctx, h.session)
    compact(h.session, start, end, snapshot)
    expect(canonical(snapshot)).toEqual([
      { name: 'stable', order: 0, text: 'Stable.' },
      { name: 'policy', order: 1, text: 'Latest, uncommitted.' },
    ])
    expect(h.session.deriveMessages().filter(message => message.role === 'system')).toEqual([
      { ...snapshot, id: h.session.deriveMessages()[0]!.id },
    ])
    expect(await h.commit()).toEqual([])
    const replay = createSession(SessionId('rebuild-replay'), h.session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(h.session.deriveMessages())
    expect(await h.commit(replay)).toEqual([])
  })

  it('preserves canonical state through repeated compaction after restart', async () => {
    const h = await harness()
    let text = 'Before.'
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text, replacement: 'Custom update.' })
    await h.commit()
    const start = user(h.session, 'Task.')
    text = 'After.'
    await h.commit()
    const end = user(h.session, 'Continue.')
    const snapshot = await rebuildCandidate(h.ctx, h.session)
    compact(h.session, start, end, snapshot)
    const replay = createSession(SessionId('repeat'), h.session.snapshotEvents())
    const restored = await rebuildCandidate(h.ctx, replay)
    expect(canonical(restored)).toEqual([{ name: 'policy', order: 1, text: 'After.' }])
    expect(restored.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')).not.toContain('Custom update.')
    const again = await rebuildCandidate(h.ctx, replay)
    expect(again.content).toEqual(restored.content)
    expect(await h.commit(replay)).toEqual([])
  })

  it.each(['', 'Legacy instructions.'])('rebuilds the head over system messages without sections, text %j', async (legacy) => {
    const h = await harness()
    const head = h.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage(legacy) }, { surfaceOp: 'append' }).seq
    user(h.session, 'Earlier task.')
    h.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Later whole prompt.') }, { surfaceOp: 'append' })
    expect(needsRebuild(h.session)).toBe(true)
    h.ctx.systemPrompt.section({ name: 'current', order: 1, text: 'Current instructions.' })
    expect(await h.commit()).toEqual(['Current instructions.'])
    expect(h.session.snapshotEvents().at(-1)?.surfaceOp).toEqual({ op: 'replace', startSeq: head, endSeq: head })
    expect(h.session.deriveMessages().map(message => [message.role, message.content])).toEqual([
      ['system', [{ type: 'text', text: 'Current instructions.' }]],
      ['user', [{ type: 'text', text: 'Earlier task.' }]],
    ])
    expect(await h.commit()).toEqual([])
  })

  it('rebuilds an empty head over a system message without sections when no sections are registered', async () => {
    const h = await harness()
    h.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Legacy instructions.') }, { surfaceOp: 'append' })
    expect(await h.commit()).toEqual([''])
    expect(h.session.deriveMessages()).toEqual([])
    expect(await h.commit()).toEqual([])
    h.ctx.systemPrompt.section({ name: 'system-prompt', order: 1, text: 'New instructions.' })
    expect(await h.commit()).toEqual(['New instructions.'])
  })

  it('preserves intervening history through complete-prompt entry, changes, empty text, and exit', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'normal', order: 1, text: 'Ordinary instructions.' })
    await h.commit()
    user(h.session, 'Ordinary task.')
    const original = h.session.deriveMessages()
    let text = 'Exclusive instructions.'
    const dispose = h.ctx.systemPrompt.section({ name: 'exclusive', order: 2, text: () => text, complete: true })
    expect(await h.commit()).toEqual(['From this point onward, the following complete system prompt replaces all earlier system-prompt sections.\n\nExclusive instructions.'])
    expect(await h.commit()).toEqual([])
    expect(h.session.deriveMessages().slice(0, original.length)).toEqual(original)
    user(h.session, 'Exclusive task.')
    const entered = h.session.deriveMessages()
    text = 'Changed exclusive instructions.'
    expect(await h.commit()).toEqual(['From this point onward, the following complete system prompt replaces all earlier system-prompt sections.\n\nChanged exclusive instructions.'])
    expect(h.session.deriveMessages().slice(0, entered.length)).toEqual(entered)
    text = ''
    expect(await h.commit()).toEqual(['From this point onward, none of the earlier system-prompt sections apply.'])
    expect(await h.commit()).toEqual([])
    dispose()
    expect(await h.commit()).toEqual(['From this point onward, the following system-prompt sections replace all earlier system-prompt sections.\n\nOrdinary instructions.\n\nThe earlier instructions from exclusive no longer apply.'])
    expect(await h.commit()).toEqual([])
    expect(h.session.deriveMessages().filter(message => message.role === 'system')).toHaveLength(5)
  })

  it.each(['', 'Exclusive instructions.'])('exits complete text %j into no active sections', async (text) => {
    const h = await harness()
    const dispose = h.ctx.systemPrompt.section({ name: 'exclusive', order: 1, text, complete: true })
    expect(await h.commit()).toEqual([text])
    expect(await h.commit()).toEqual([])
    dispose()
    expect(await h.commit()).toEqual(['From this point onward, none of the earlier system-prompt sections apply.\n\nThe earlier instructions from exclusive no longer apply.'])
    expect(await h.commit()).toEqual([])
    h.ctx.systemPrompt.section({ name: 'exclusive', order: 1, text: 'Ordinary instructions.' })
    expect(await h.commit()).toEqual(['Ordinary instructions.'])
  })

  it('restores unchanged ordinary text after a complete override with the same name', async () => {
    const h = await harness()
    const remove = h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Same instructions.' })
    await h.commit()
    remove()
    const leave = h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Same instructions.', complete: true })
    expect(await h.commit()).toEqual(['From this point onward, the following complete system prompt replaces all earlier system-prompt sections.\n\nSame instructions.'])
    leave()
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Same instructions.' })
    expect(await h.commit()).toEqual(['From this point onward, the following system-prompt sections replace all earlier system-prompt sections.\n\nSame instructions.'])
    expect(await h.commit()).toEqual([])
  })

  it('includes a producer retirement notice when leaving a complete override', async () => {
    const h = await harness()
    const leave = h.ctx.systemPrompt.section({ name: 'exclusive', order: 1, text: 'Exclusive instructions.', complete: true, retirement: 'The exclusive task has ended.' })
    await h.commit()
    leave()
    expect(await h.commit()).toEqual(['From this point onward, none of the earlier system-prompt sections apply.\n\nThe exclusive task has ended.'])
    expect(await h.commit()).toEqual([])
  })

  it('does not advance a complete transition before its message is committed', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'normal', order: 1, text: 'Ordinary instructions.' })
    await h.commit()
    h.ctx.systemPrompt.section({ name: 'exclusive', order: 2, text: 'Exclusive instructions.', complete: true })
    const assembly = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(admittedMessages(assembly)[0]?.source.reset).toBe(true)
    expect(admittedMessages((await h.ctx.systemPrompt.assemble({ session: h.session })))).toHaveLength(1)
    await h.commit(h.session, {}, assembly)
    expect(await h.commit()).toEqual([])
  })

  it('rebuilds complete prompts as the latest admission state', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'normal', order: 1, text: 'Ordinary instructions.' })
    await h.commit()
    const task = user(h.session, 'Earlier task.')
    const leave = h.ctx.systemPrompt.section({ name: 'exclusive', order: 2, text: 'Exclusive instructions.', complete: true })
    await h.commit()
    const end = h.session.surface.nodes.at(-1)!
    const snapshot = await rebuildCandidate(h.ctx, h.session)
    expect(snapshot.source.complete).toBe(true)
    compact(h.session, task, end, snapshot)
    expect(await h.commit()).toEqual([])
    leave()
    expect((await h.commit())[0]).toContain('Ordinary instructions.')
    expect(await h.commit()).toEqual([])
  })

  it.each(['', ' \n\t '])('rejects blank custom retirement text before registering: %j', async (retirement) => {
    const h = await harness()
    expect(() => h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Instructions.', retirement }))
      .toThrow('nonempty literal')
    expect((await h.ctx.systemPrompt.assemble({ session: h.session })).sections.find(section => section.name === 'policy')).toBeUndefined()
  })

  it('omits retired sources from a full rebuild and introduces them normally afterward', async () => {
    const h = await harness()
    const release = h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Before.' })
    await h.commit()
    const start = user(h.session, 'First.')
    release()
    await h.commit()
    const end = h.session.surface.nodes.at(-1)!
    const snapshot = await rebuildCandidate(h.ctx, h.session)
    expect(canonical(snapshot)).toEqual([])
    expect(snapshot.content).toEqual([])
    compact(h.session, start, end, snapshot)
    expect(await h.commit()).toEqual([])
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Before.' })
    expect(await h.commit()).toEqual(['Before.'])
  })

  it('does not rebuild for a retained tool-result replacement', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Instructions.' })
    await h.commit()
    const result = h.session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('read'), isError: false, content: [{ type: 'text', text: 'Large result.' }] }),
    }, { surfaceOp: 'append' })
    h.session.append('tool/result', { ...result.data,
      message: { ...result.data.message, content: [{ type: 'text', text: 'Saved to file.' }] },
    }, { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] })
    expect(await h.commit()).toEqual([])
  })

  it('rejects ambiguous assembled identities before writing admission metadata', async () => {
    const h = await harness()
    let sections = [{ name: '', order: 0, text: 'Invalid.' }]
    h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), sections }))
    await expect(h.ctx.systemPrompt.assemble({ session: h.session })).rejects.toThrow('name must be nonempty')
    sections = [{ name: 'same', order: 0, text: 'First.' }, { name: 'same', order: 1, text: 'Second.' }]
    await expect(h.ctx.systemPrompt.assemble({ session: h.session })).rejects.toThrow('duplicate assembled')
    expect(h.session.deriveMessages()).toEqual([])
  })

  it('waits for projection composition before exposing the service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    expect(ctx.systemPrompt).toBeUndefined()
    await ctx.plugin(SessionProjectionRegistry)
    const assembly = await ctx.systemPrompt.assemble()
    expect(admittedMessages(assembly)).toEqual([])
  })

  it('waits for projection registration and fails activation if registration fails', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    const register = vi.spyOn(SessionProjectionRegistry.prototype, 'register').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await resume.promise
      throw new Error('Registration failed.')
    })
    try {
      const activation = ctx.plugin(SystemPrompt)
      await entered.promise
      expect(activation.state).toBe(FiberState.LOADING)
      resume.resolve(undefined)
      await expect(activation).rejects.toThrow('Registration failed.')
      expect(ctx.systemPrompt).toBeUndefined()
    } finally {
      resume.resolve(undefined)
      register.mockRestore()
    }
  })

  it.each([false, true])('preserves captured definitions when a new registration fails, previous=%s', async (previous) => {
    const h = await harness()
    if (previous) {
      const release = h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Instructions.', retirement: 'Retired.' })
      await h.commit()
      release()
    }
    let rejected = false
    const off = h.ctx.on('system-prompt/change', () => {
      if (!rejected) {
        rejected = true
        throw new Error('notification failed')
      }
    })
    expect(() => h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Rejected instructions.' })).toThrow('notification failed')
    off()
    expect(await h.commit()).toEqual(previous ? ['Retired.'] : [''])
  })

  it('captures lifecycle and text before asynchronous presentation finishes', async () => {
    const h = await harness()
    const release = h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Captured.' })
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const resume: PromiseWithResolvers<void> = Promise.withResolvers()
    const off = h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      entered.resolve(undefined)
      await resume.promise
      return assembly
    })
    const pending = h.ctx.systemPrompt.assemble({ session: h.session })
    await entered.promise
    release()
    resume.resolve(undefined)
    const captured = await pending
    off()
    expect(await h.commit(h.session, {}, captured)).toEqual(['Captured.'])
    expect(await h.commit()).toEqual(['The earlier instructions from policy no longer apply.'])
  })

  it('records clean section text separately from notices and preserves changed order', async () => {
    const h = await harness()
    const release = h.ctx.systemPrompt.section({ name: 'policy', order: 20, text: 'Before.' })
    await h.commit()
    release()
    const changed = h.ctx.systemPrompt.section({ name: 'policy', order: 20, text: 'After.', replacement: 'Custom notice.' })
    const assembly = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(canonical(admittedMessages(assembly)[0]!)).toEqual([{ name: 'policy', order: 20, text: 'After.' }])
    expect(await h.commit(h.session, {}, assembly)).toEqual(['Custom notice.\n\nAfter.'])
    changed()
    h.ctx.systemPrompt.section({ name: 'policy', order: 5, text: 'After.', replacement: 'Not a text change.' })
    expect(await h.commit()).toEqual(['After.'])
    const snapshot = await rebuildCandidate(h.ctx, h.session)
    expect(canonical(snapshot)).toEqual([{ name: 'policy', order: 5, text: 'After.' }])
    expect(await h.commit()).toEqual([])
  })

  it.each(['usable', 'missing', 'incompatible'] as const)('restores admission through a %s projection checkpoint', async (kind) => {
    const h = await harness()
    let text = 'Before.'
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text })
    await h.commit()
    const prefixLength = h.session.snapshotEvents().length
    const checkpoint = h.ctx.sessionProjections.checkpoint(h.session)
    text = 'After.'
    await h.commit()
    markCompaction(h.session)
    const all = h.session.snapshotEvents()
    if (kind === 'missing') delete checkpoint['systemSections']
    if (kind === 'incompatible') checkpoint['systemSections']!.ver = 1
    const floor = kind === 'usable' ? prefixLength : 0
    const restored = createSession(SessionId('checkpoint-replay'), all)
    h.ctx.sessionProjections.hydrate(restored, checkpoint, all.slice(floor), SessionLogOffset(floor))
    expect(needsRebuild(restored)).toBe(true)
    expect(restored.surface.systemNodes).toEqual(h.session.surface.systemNodes)
    expect(await h.commit(restored)).toEqual(['After.'])
    expect(needsRebuild(restored)).toBe(false)
    expect(await h.commit(restored)).toEqual([])
    const replay = createSession(SessionId('checkpoint-rebuilt'), restored.snapshotEvents())
    expect(needsRebuild(replay)).toBe(false)
    expect(replay.surface.systemNodes).toEqual(restored.surface.systemNodes)
  })

  it.each(['single', 'range'] as const)('keeps cited system nodes outside a %s replacement available for rebuilding', async (kind) => {
    const h = await harness()
    let text = 'First.'
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text })
    await h.commit()
    const head = h.session.surface.nodes[0]!
    const start = user(h.session, 'Old input.')
    text = 'Second.'
    await h.commit()
    const tail = h.session.surface.nodes.at(-1)!
    const end = user(h.session, 'End of selection.')
    text = 'Third.'
    await h.commit()
    const outside = h.session.surface.nodes.at(-1)!
    markCompaction(h.session)
    if (kind === 'single') {
      h.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Replacement.') }, {
        surfaceOp: { op: 'replace', startSeq: tail, endSeq: tail }, sourceEventSeqs: [tail, head, outside],
      })
    } else {
      h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary.' }], source: { kind: 'user' } }), {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [start, tail, end, head, outside],
      })
    }
    const restored = createSession(SessionId('citation-replay'), h.session.snapshotEvents())
    expect(restored.surface.systemNodes[0]?.seq).toBe(head)
    expect(restored.surface.systemNodes.at(-1)?.seq).toBe(outside)
    expect(needsRebuild(restored)).toBe(true)
    await h.commit(restored)
    expect(restored.snapshotEvents().at(-1)?.sourceEventSeqs).toEqual([head])
    expect(restored.deriveMessages().filter(message => message.role === 'system').map(message => message.content))
      .toEqual([[{ type: 'text', text: 'Third.' }]])
    expect(needsRebuild(restored)).toBe(false)
  })

  it('keeps a rebuild pending across discarded assembly and replay until the head reset commits', async () => {
    const h = await harness()
    let text = 'Before.'
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text, replacement: 'Changed.' })
    await h.commit()
    text = 'Pending.'
    const captured = await h.ctx.systemPrompt.assemble({ session: h.session })
    user(h.session, 'Unrelated input.')
    expect(admittedMessages(captured)[0]?.content).toEqual([{ type: 'text', text: 'Changed.' }, { type: 'text', text: 'Pending.' }])
    markCompaction(h.session)
    // The same captured sections now produce the full prompt without a notice.
    expect(admittedMessages(captured)[0]?.content).toEqual([{ type: 'text', text: 'Pending.' }])
    expect(needsRebuild(h.session)).toBe(true)
    const discarded = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(admittedMessages(discarded)[0]?.content).toEqual([{ type: 'text', text: 'Pending.' }])
    expect(needsRebuild(h.session)).toBe(true)
    const replay = createSession(SessionId('pending-replay'), h.session.snapshotEvents())
    expect(needsRebuild(replay)).toBe(true)
    markCompaction(h.session)
    expect(needsRebuild(h.session)).toBe(true)
    text = 'Current.'
    expect(await h.commit()).toEqual(['Current.'])
    expect(needsRebuild(h.session)).toBe(false)
    expect(await h.commit()).toEqual([])
    const committed = createSession(SessionId('committed-replay'), h.session.snapshotEvents())
    expect(needsRebuild(committed)).toBe(false)
    expect(await h.commit(committed)).toEqual([])
  })

  it('resumes partial cleanup without calling Session.eventAt or replacing already empty nodes', async () => {
    const h = await harness()
    let text = 'First.'
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text })
    await h.commit()
    const head = h.session.surface.nodes[0]!
    text = 'Second.'
    await h.commit()
    const cleared = h.session.surface.nodes.at(-1)!
    text = 'Third.'
    await h.commit()
    const retained = h.session.surface.nodes.at(-1)!
    markCompaction(h.session)
    h.session.append('system/message', {
      turn: 1, step: 1,
      message: { ...createSystemMessage(''), content: [], source: { kind: 'system-prompt', sections: [] } },
    }, { surfaceOp: { op: 'replace', startSeq: cleared, endSeq: cleared }, sourceEventSeqs: [cleared] })
    const restored = createSession(SessionId('partial-cleanup'), h.session.snapshotEvents())
    const before = restored.snapshotEvents().length
    const assembly = await h.ctx.systemPrompt.assemble({ session: restored })
    const history = vi.spyOn(restored, 'eventAt').mockImplementation(() => { throw new Error('Unexpected history read.') })
    try {
      admit(restored, assembly)
    } finally {
      history.mockRestore()
    }
    expect(restored.snapshotEvents().slice(before).map(event => event.sourceEventSeqs)).toEqual([[retained], [head]])
    expect(restored.deriveMessages().map(message => message.content)).toEqual([[{ type: 'text', text: 'Third.' }]])
    expect(needsRebuild(restored)).toBe(false)
    expect(await h.commit(restored)).toEqual([])
  })

  it('retains the pending rebuild when assembly is cancelled', async () => {
    const h = await harness()
    await h.commit()
    markCompaction(h.session)
    const controller = new AbortController()
    controller.abort(new Error('Assembly cancelled.'))
    const off = h.ctx.on('system-prompt/assemble', (_assembly, context, next) => {
      context.signal?.throwIfAborted()
      return next()
    })
    await expect(h.ctx.systemPrompt.assemble({ session: h.session, signal: controller.signal })).rejects.toThrow('Assembly cancelled.')
    off()
    expect(needsRebuild(h.session)).toBe(true)
    expect(await h.commit()).toEqual([''])
    expect(needsRebuild(h.session)).toBe(false)
  })

  it('rebuilds from an assembly captured before compaction, and again after a later compaction', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Before.' })
    await h.commit()
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    const off = h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      entered.resolve(undefined)
      await resume.promise
      return next()
    })
    const assembling = h.ctx.systemPrompt.assemble({ session: h.session })
    await entered.promise
    off()
    markCompaction(h.session)
    resume.resolve(undefined)
    const assembly = await assembling
    expect(admittedMessages(assembly)[0]?.source.reset).toBe(true)
    expect(await h.commit(h.session, {}, assembly)).toEqual(['Before.'])
    expect(needsRebuild(h.session)).toBe(false)
    expect(await h.commit(h.session, {}, assembly)).toEqual([])
    markCompaction(h.session)
    expect(await h.commit(h.session, {}, assembly)).toEqual(['Before.'])
    expect(await h.commit(h.session, {}, assembly)).toEqual([])
  })

  it('returns only a pending rebuild for a retry', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Instructions.' })
    const assembly = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(assembly.systemUpdates(true)).toEqual([])
    await h.commit(h.session, {}, assembly)
    markCompaction(h.session)
    expect(assembly.systemUpdates(true).map(update => update.message.source.reset)).toEqual([true])
  })

  it('does not clear pending rebuilding for emptied tail messages', async () => {
    const h = await harness()
    let text = 'Complete.'
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text, complete: true })
    await h.commit()
    text = 'Changed.'
    await h.commit()
    const tail = h.session.surface.nodes.at(-1)!
    markCompaction(h.session)
    const reset = admittedMessages((await h.ctx.systemPrompt.assemble({ session: h.session })))[0]!
    h.session.append('system/message', { turn: 1, step: 1, message: { ...reset, content: [], source: { kind: 'system-prompt', sections: [] } } }, {
      surfaceOp: { op: 'replace', startSeq: tail, endSeq: tail }, sourceEventSeqs: [tail],
    })
    expect(needsRebuild(h.session)).toBe(true)
    expect(admittedMessages((await h.ctx.systemPrompt.assemble({ session: h.session })))[0]?.source.complete).toBe(true)
    rebuild(h.session, reset)
    expect(needsRebuild(h.session)).toBe(false)
  })

  it('settles a pending rebuild with the first canonical system message, even when empty', async () => {
    const h = await harness()
    markCompaction(h.session)
    expect(await h.commit()).toEqual([''])
    expect(needsRebuild(h.session)).toBe(false)
    const first = h.session.snapshotEvents().find(event => event.type === 'system/message')
    expect(first?.data.message.source).toMatchObject({ reset: true, sections: [] })
    expect(await h.commit()).toEqual([])
  })

  it('rebuilds only currently registered sources after restart', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'old', order: 1, text: 'Previous process.' })
    await h.commit()
    const restarted = await harness()
    const restored = createSession(SessionId('restart-rebuild'), h.session.snapshotEvents())
    expect((await rebuildCandidate(restarted.ctx, restored)).content).toEqual([])
  })

  it.each([false, true])('settles a rebuild after a non-initial head is compacted, surviving update=%s', async (surviving) => {
    const h = await harness()
    const start = user(h.session, 'Imported conversation without an initial system node.')
    let text = 'Before.'
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text })
    await h.commit()
    const oldHead = h.session.surface.nodes.at(-1)!
    let target: SessionSeq | undefined
    if (surviving) {
      text = 'Current.'
      await h.commit()
      target = h.session.surface.nodes.at(-1)!
    }
    markCompaction(h.session, start, oldHead)
    h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: oldHead }, sourceEventSeqs: [start, oldHead],
    })
    const assembly = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(needsRebuild(h.session)).toBe(true)
    await h.commit(h.session, {}, assembly)
    const rebuilt = h.session.snapshotEvents().at(-1)!
    expect(rebuilt.surfaceOp).toEqual(target === undefined
      ? 'append'
      : { op: 'replace', startSeq: target, endSeq: target })
    expect(needsRebuild(h.session)).toBe(false)
    expect(await h.commit()).toEqual([])
    const restored = createSession(SessionId('removed-head-replay'), h.session.snapshotEvents())
    expect(needsRebuild(restored)).toBe(false)
    expect(await h.commit(restored)).toEqual([])
  })

  it('omits an uncommitted retirement notice from a pending full rebuild', async () => {
    const h = await harness()
    const dispose = h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: 'Before.', retirement: 'Retired.' })
    await h.commit()
    dispose()
    markCompaction(h.session)
    const assembly = await h.ctx.systemPrompt.assemble({ session: h.session })
    expect(admittedMessages(assembly)[0]?.content).toEqual([])
    expect(admittedMessages(assembly)[0]?.source.sections).toEqual([])
    await h.commit(h.session, {}, assembly)
    expect(await h.commit()).toEqual([])
  })

  it('recognizes an attributed empty head before admitting a complete prompt', async () => {
    const h = await harness()
    h.session.append('system/message', { turn: 1, step: 1, message: {
      ...createSystemMessage(''), content: [], source: { kind: 'system-prompt', sections: [] },
    } }, { surfaceOp: 'append' })
    expect(await h.commit()).toEqual([])
    h.ctx.systemPrompt.section({ name: 'complete', order: 1, text: 'Complete instructions.', complete: true })
    expect(await h.commit()).toEqual(['Complete instructions.'])
    expect(await h.commit()).toEqual([])
  })

  it('allows a text update without a replacement notice', async () => {
    const h = await harness()
    let text = 'Before.'
    h.ctx.systemPrompt.section({ name: 'policy', order: 1, text: () => text, replacement: '' })
    await h.commit()
    text = 'After.'
    expect(await h.commit()).toEqual(['After.'])
  })

  it('omits retirement of a source absent from committed state', () => {
    const session = createSession(SessionId('no-admission'))
    const state = sectionAdmissionsDefinition.init(session.header, session.inheritedEventCount)
    expect(assembleSystemAdmission(state, [
      { kind: 'retired', name: 'uncommitted', order: 1, notice: 'Retired.', complete: false },
    ])).toEqual({ kind: 'append', messages: [] })
  })

  it('orders rebuilt sections by numeric order and then source name', async () => {
    const h = await harness()
    for (const [name, order] of [['z', 5], ['early', 1], ['a', 5], ['m', 5]] as const) {
      h.ctx.systemPrompt.section({ name, order, text: name })
      await h.commit()
    }
    const snapshot = await rebuildCandidate(h.ctx, h.session)
    expect(canonical(snapshot).map(section => section.name)).toEqual(['early', 'a', 'm', 'z'])
  })



  it('restores the deployment persona after a scoped section is disposed', async () => {
    const h = await harness()
    const key = { name: 'persona' }
    let scope!: ReturnType<typeof createScope>
    await h.ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['systemPrompt'] }))
    const dispose = scope.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix', order: scope.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: 'Scoped persona.',
    })
    expect(await h.commit(h.session, { scope: key })).toEqual(['Scoped persona.'])
    dispose()
    const assembly = await h.ctx.systemPrompt.assemble({ session: h.session, scope: key })
    expect(admittedMessages(assembly)[0]?.source.sections).toMatchObject([
      { name: 'deployment:persona-prefix', state: 'active' },
    ])
    await h.commit(h.session, { scope: key }, assembly)
    expect(await h.commit(h.session, { scope: key })).toEqual([])
    await scope.dispose()
  })

})

/** Messages an assembly would admit now, excluding the cleanup writes that precede a rebuilt head. */
function admittedMessages(assembly: PromptAssembly) {
  return assembly.systemUpdates(false)
    .filter(({ message, intent }) => intent.surfaceOp === 'append' || message.source.reset === true)
    .map(({ message }) => message)
}
