import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type Message } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, Inbox, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'

const testToolSignal = new AbortController().signal

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(home: string, config: toolSkill.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(toolSkill, config)
  return ctx
}

function agentForCwd(cwd: string): Agent {
  const id = SessionId(`tool-skill-${cwd}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('step-boundary catalog must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function sessionAgent(session: Session, id = 'tool-skill-agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('step-boundary catalog must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function openMessageTurn(session: Session, turn = 1): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

async function fireStep(ctx: Context, agent: Agent, turn: number, step: number): Promise<void> {
  const signal = new AbortController().signal
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

async function proposeStep(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[],
): Promise<PreStepDecision> {
  const signal = new AbortController().signal
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

function catalogMessages(session: Session): Extract<SessionEvent, { type: 'user/message' }>[] {
  return session.snapshotEvents().filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => event.type === 'user/message'
    && event.data.source.kind === 'skill-catalog')
}

function readableCatalog(event: Extract<SessionEvent, { type: 'user/message' }>): boolean {
  const entries = (event.data.source as { entries?: unknown }).entries
  return Array.isArray(entries)
    && entries.every(entry => typeof entry === 'object' && entry !== null
      && typeof (entry as { name?: unknown }).name === 'string'
      && typeof (entry as { description?: unknown }).description === 'string')
}

function catalogContent(entries: string[]): Message['content'] {
  return [{
    type: 'text',
    text: ['<system-reminder>', '<available_skills>', ...entries, '</available_skills>', '</system-reminder>'].join('\n'),
  }]
}

async function composePrefix(ctx: Context, cwd: string, signal = new AbortController().signal): Promise<Message[]> {
  return await composePrefixForAgent(ctx, agentForCwd(cwd), signal)
}

async function composePrefixForAgent(ctx: Context, agent: Agent, signal = new AbortController().signal): Promise<Message[]> {
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  return agent.session.deriveMessages()
}

async function mintAgentScope(ctx: Context, subject: string | Agent): Promise<{ agent: Agent; scope: Scope }> {
  const agent = typeof subject === 'string' ? agentForCwd(subject) : subject
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools'],
  }))
  return { agent, scope }
}

describe('dsh-tool-skill', () => {
  it('registers the skill tool schema and removes it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const home = await tempDir('tool-schema')
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
    ctx.skills.register({ name: 'lifecycle-skill', description: 'Lifecycle', source: 'runtime', content: 'body' })

    const fiber = await ctx.plugin(toolSkill)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
    expect(await composePrefix(ctx, '/workspace')).toHaveLength(1)
    expect(ctx.tools.get('skill')?.presentCall?.({ name: 'project-skill' })).toEqual({
      card: 'generic',
      title: 'Load skill project-skill',
      kind: 'read',
      rawInput: 'project-skill',
    })
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(await composePrefix(ctx, '/workspace')).toEqual([])

    toolSkill.apply(ctx)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
  })

  it('forwards the step abort signal to skill discovery', async () => {
    const home = await tempDir('tool-prefix-signal')
    const ctx = await setup(home)
    let seenSignal: AbortSignal | undefined
    ctx.skills.registerProvider(() => ({
      name: 'signal-probe',
      async list(options) {
        seenSignal = options.signal
        return []
      },
      async get() {
        return undefined
      },
    }))
    const controller = new AbortController()

    await composePrefix(ctx, '/workspace', controller.signal)

    expect(seenSignal).toBe(controller.signal)
  })

  it('injects a stable durable name-and-description catalog at the first step', async () => {
    const home = await tempDir('tool-catalog')
    const ctx = await setup(home, { catalogDescriptionMaxLength: 50 })
    ctx.skills.register({
      name: 'z-skill',
      description: 'Long   description '.repeat(5),
      whenToUse: 'Never render this routing hint.',
      source: 'secret-source',
      provider: 'runtime',
      resourceBase: { kind: 'directory', path: '/secret/path' },
      content: 'Secret body.',
    })
    ctx.skills.register({
      name: 'a-skill',
      description: 'Use {{placeholder}} <safely> & carefully.',
      source: 'runtime',
      provider: 'runtime',
      content: 'A body.',
    })
    ctx.skills.register({
      name: 'model-only-skill',
      description: 'Model-only skill.',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only body.',
    })
    ctx.skills.register({
      name: 'user-only-skill',
      description: 'User-only skill.',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'User-only body.',
    })
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: 'later contribution' }],
            source: { kind: 'plugin', plugin: 'later-contribution' },
          }),
        ],
      }
    })

    const prefix = await composePrefix(ctx, '/workspace')

    expect(prefix).toEqual([
      {
        id: expect.any(String) as unknown,
        role: 'user',
        content: [{ type: 'text', text: 'later contribution' }],
        source: { kind: 'plugin', plugin: 'later-contribution' },
      },
      {
        id: expect.any(String) as unknown,
        role: 'user',
        source: {
          kind: 'skill-catalog',
          form: 'catalog',
          entries: [
            { name: 'a-skill', description: 'Use {{placeholder}} <safely> & carefully.' },
            { name: 'model-only-skill', description: 'Model-only skill.' },
            { name: 'z-skill', description: 'Long description Long description Long descript...' },
          ],
        },
        content: [{
          type: 'text',
          text: [
            '<system-reminder>',
            'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
            '',
            '<available_skills>',
            '- `a-skill`: Use {{placeholder}} &lt;safely&gt; &amp; carefully.',
            '- `model-only-skill`: Model-only skill.',
            '- `z-skill`: Long description Long description Long descript...',
            '</available_skills>',
            '',
            "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
            'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
            '</system-reminder>',
          ].join('\n'),
        }],
      },
    ])
    const rendered = JSON.stringify(prefix[1])
    expect(rendered).not.toContain('whenToUse')
    expect(rendered).not.toContain('secret-source')
    expect(rendered).not.toContain('/secret/path')
    expect(rendered).not.toContain('Secret body')
    expect(rendered).not.toContain('user-only-skill')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ agent: agentForCwd('/workspace') }))).not.toContain('<available_skills>')
  })

  it('does not inject a catalog when no model-invocable skills are available', async () => {
    const home = await tempDir('tool-empty-catalog')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'user-only-skill',
      description: 'User-only skill',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'User-only body.',
    })

    const agent = agentForCwd('/workspace')
    expect(await composePrefixForAgent(ctx, agent)).toEqual([])
    expect(await composePrefixForAgent(ctx, agent)).toEqual([])
  })

  it('omits an incomplete initial catalog and retries on a later request boundary', async () => {
    const home = await tempDir('tool-incomplete-prefix')
    const ctx = await setup(home)
    let failing = true
    const provider = {
      name: 'recovering',
      async list() {
        if (failing) throw new Error('temporarily unavailable')
        return []
      },
      async get() {
        return undefined
      },
    }
    let invalidate = (): void => {}
    ctx.skills.registerProvider((control) => {
      invalidate = control.invalidate
      return provider
    })
    const session = Session.create(SessionId('incomplete-prefix'))
    const agent = sessionAgent(session)
    openMessageTurn(session)

    await composePrefixForAgent(ctx, agent)
    expect(catalogMessages(session)).toEqual([])
    failing = false
    invalidate()
    await fireStep(ctx, agent, 1, 1)

    expect(catalogMessages(session)).toEqual([])
  })

  it('records an empty baseline across repeated step observations', async () => {
    const home = await tempDir('tool-empty-step')
    const ctx = await setup(home)
    const session = Session.create(SessionId('empty-step'))
    const agent = sessionAgent(session)
    openMessageTurn(session)

    await fireStep(ctx, agent, 1, 1)
    await fireStep(ctx, agent, 1, 2)

    expect(catalogMessages(session)).toEqual([])
  })

  it('deduplicates or replaces a catalog already proposed for the same step', async () => {
    const home = await tempDir('tool-proposed-catalog')
    const ctx = await setup(home)
    const disposeFirst = ctx.skills.register({
      name: 'first-skill',
      description: 'First skill',
      source: 'runtime',
      content: 'First body.',
    })
    const session = Session.create(SessionId('proposed-catalog'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    await fireStep(ctx, agent, 1, 1)
    const initial = catalogMessages(session)[0]?.data
    if (initial === undefined) throw new Error('expected initial catalog')

    const duplicate = await proposeStep(ctx, agent, [initial])
    expect(duplicate).toEqual({ kind: 'enter', messages: [] })

    ctx.skills.register({
      name: 'second-skill',
      description: 'Second skill',
      source: 'runtime',
      content: 'Second body.',
    })
    const companion = createUserMessage({
      content: [{ type: 'text', text: 'keep this message' }],
      source: { kind: 'user' },
    })
    const replaced = await proposeStep(ctx, agent, [companion, initial])
    expect(replaced.kind).toBe('enter')
    if (replaced.kind === 'reject') throw new Error('expected catalog replacement')
    expect(replaced.messages).toHaveLength(2)
    expect(replaced.messages[0]).toBe(companion)
    expect(replaced.messages[1]?.id).not.toBe(initial.id)
    expect(JSON.stringify(replaced.messages[1]?.content)).toContain('second-skill')

    disposeFirst()
  })

  it('removes a stale proposed catalog before the first empty baseline', async () => {
    const home = await tempDir('tool-proposed-empty-catalog')
    const ctx = await setup(home)
    const session = Session.create(SessionId('proposed-empty-catalog'))
    const malformed = createUserMessage({
      content: [{ type: 'text', text: 'preserve unreadable claimed context' }],
      source: { kind: 'skill-catalog', form: 'catalog' } as never,
    })
    const stale = createUserMessage({
      content: catalogContent(['- `stale-skill`: Stale skill']),
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'stale-skill', description: 'Stale skill' }],
      },
    })

    const decision = await proposeStep(ctx, sessionAgent(session), [malformed, stale])

    expect(decision).toEqual({ kind: 'enter', messages: [malformed] })
  })

  it('keeps a proposed catalog that already matches the current snapshot', async () => {
    const home = await tempDir('tool-matching-proposal')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'first-skill',
      description: 'First skill',
      source: 'runtime',
      content: 'First body.',
    })
    const session = Session.create(SessionId('matching-proposal'))
    const proposed = createUserMessage({
      content: catalogContent(['- `first-skill`: First skill']),
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'first-skill', description: 'First skill' }],
      },
    })

    const decision = await proposeStep(ctx, sessionAgent(session), [proposed])

    expect(decision).toEqual({ kind: 'enter', messages: [proposed] })
  })

  it('injects complete replacement catalogs for additions and an empty tombstone for removals', async () => {
    const home = await tempDir('tool-dynamic-catalog')
    const ctx = await setup(home)
    const disposeFirst = ctx.skills.register({
      name: 'first-skill',
      description: 'First skill',
      source: 'runtime',
      content: 'First body.',
    })
    const session = Session.create(SessionId('dynamic-catalog'))
    const agent = sessionAgent(session)
    openMessageTurn(session)

    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('first-skill')
    await fireStep(ctx, agent, 1, 1)
    expect(catalogMessages(session)).toHaveLength(1)

    const disposeSecond = ctx.skills.register({
      name: 'second-skill',
      description: 'Second skill',
      source: 'runtime',
      content: 'Second body.',
    })
    await fireStep(ctx, agent, 1, 2)

    const addition = catalogMessages(session)[1]
    if (addition?.type !== 'user/message') throw new Error('expected catalog addition')
    expect(JSON.stringify(addition.data.content)).toContain('first-skill')
    expect(JSON.stringify(addition.data.content)).toContain('second-skill')

    disposeSecond()
    disposeFirst()
    await fireStep(ctx, agent, 1, 3)

    const removal = catalogMessages(session)[2]
    if (removal?.type !== 'user/message') throw new Error('expected catalog removal')
    expect(JSON.stringify(removal.data.content)).toContain('No skills are currently available')
    expect(JSON.stringify(removal.data.content)).not.toContain('first-skill')
    expect(JSON.stringify(removal.data.content)).not.toContain('second-skill')

    await fireStep(ctx, agent, 1, 4)
    expect(catalogMessages(session)).toHaveLength(3)
  })

  it('resumes from the durable entries of the latest visible catalog', async () => {
    // Catalog identity lives on `source.entries`: the model-facing prose does
    // not decide whether a republish is needed, so a seeded message is
    // recognized by its source alone and malformed prose cannot hide (or fake)
    // a published catalog. A foreign-sourced message is not this plugin's
    // catalog at all.
    const home = await tempDir('tool-catalog-resume')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'resumed-skill',
      description: 'Resumed skill',
      source: 'runtime',
      content: 'Resumed body.',
    })
    const session = Session.create(SessionId('catalog-resume'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prose a reader cannot rely on' }],
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'old-skill', description: 'Old skill' }],
      },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: catalogContent(['- `resumed-skill`: Resumed skill']),
      source: { kind: 'plugin', plugin: 'dsh-tool-skill' },
    }), { surfaceOp: 'append' })

    await fireStep(ctx, agent, 1, 1)

    // The seeded entries differ from the live snapshot, so one replacement
    // lands; the foreign-sourced lookalike neither counts as published nor
    // suppresses it.
    expect(catalogMessages(session)).toHaveLength(2)
    const latest = catalogMessages(session).at(-1)
    expect(latest?.data.source).toMatchObject({
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries: [{ name: 'resumed-skill', description: 'Resumed skill' }],
    })
    expect(JSON.stringify(latest?.data.content)).toContain('resumed-skill')

    // A second step over unchanged entries republishes nothing.
    await fireStep(ctx, agent, 1, 2)
    expect(catalogMessages(session)).toHaveLength(2)
  })

  it('treats a malformed durable catalog as unrecognizable instead of failing the step', async () => {
    // Seeds reach `agent.session.snapshotEvents()` from persistence on resume or fork,
    // and seed validation only guarantees a source object with a non-empty
    // `kind`. A catalog whose entries are missing or wrongly shaped must be
    // skipped like any foreign record; throwing here would fail every later
    // step of that session at the latest possible point.
    const home = await tempDir('tool-catalog-malformed')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'live-skill',
      description: 'Live skill',
      source: 'runtime',
      content: 'Live body.',
    })
    const session = Session.create(SessionId('catalog-malformed'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    for (const source of [
      { kind: 'skill-catalog', form: 'catalog' },
      { kind: 'skill-catalog', form: 'catalog', entries: null },
      { kind: 'skill-catalog', form: 'catalog', entries: 'not-an-array' },
      { kind: 'skill-catalog', form: 'catalog', entries: [null] },
      { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'x' }] },
      { kind: 'skill-catalog', form: 'catalog', entries: [{ description: 'no name' }] },
    ]) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'unreadable catalog' }],
        source: source as never,
      }), { surfaceOp: 'append' })
    }

    await expect(fireStep(ctx, agent, 1, 1)).resolves.toBeUndefined()

    // None of the six counted as published, so the live catalog lands as a
    // first publication rather than a replacement.
    const published = catalogMessages(session).filter(event => readableCatalog(event))
    expect(published).toHaveLength(1)
    expect(published[0]?.data.source).toMatchObject({ kind: 'skill-catalog', form: 'catalog' })
    expect(published[0]?.data.source).not.toHaveProperty('update')
    expect(JSON.stringify(published[0]?.data.content)).toContain('live-skill')
  })

  it('rejects a missing event below the current Session length', async () => {
    const home = await tempDir('tool-catalog-missing-event')
    const ctx = await setup(home)
    const session = Session.create(SessionId('catalog-missing-event'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    Object.defineProperty(session, 'eventAt', { value: () => undefined })

    await expect(fireStep(ctx, agent, 1, 1))
      .rejects.toThrow('skill catalog cannot read seq 1 below the current Session length')
  })

  it('re-establishes the current catalog after compaction hides its durable message', async () => {
    const home = await tempDir('tool-catalog-compaction')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'first-skill',
      description: 'First skill',
      source: 'runtime',
      content: 'First body.',
    })
    const session = Session.create(SessionId('catalog-compaction'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('first-skill')
    const initial = catalogMessages(session)[0]
    if (initial === undefined) throw new Error('expected initial catalog')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted history' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), {
      surfaceOp: { op: 'replace', start: initial.seq, end: initial.seq },
      sourceEventSeqs: [initial.seq],
    })

    await fireStep(ctx, agent, 1, 1)

    expect(catalogMessages(session)).toHaveLength(2)
    expect(JSON.stringify(catalogMessages(session).at(-1)?.data.content)).toContain('first-skill')
  })

  it('keeps body-only edits out of the catalog and loads the latest body on demand', async () => {
    const home = await tempDir('tool-body-refresh')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'body-skill', 'Stable description', 'First body.')
    const ctx = await setup(home)
    const session = Session.create(SessionId('body-refresh'))
    const agent = sessionAgent(session)
    openMessageTurn(session)

    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('Stable description')
    await writeSkill(root, 'body-skill', 'Stable description', 'Second body.')
    await fireStep(ctx, agent, 1, 1)
    expect(catalogMessages(session)).toHaveLength(1)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('body-refresh'),
      name: 'skill',
      arguments: { name: 'body-skill' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Second body.')
    expect(JSON.stringify(result.content)).not.toContain('First body.')
  })

  it('resolves the layered registry as the calling agent sees it', async () => {
    const home = await tempDir('tool-scoped-layer')
    const ctx = await setup(home)
    const { agent, scope } = await mintAgentScope(ctx, '/workspace/scoped')
    const scopedSkills = scope.ctx.get('skills')
    if (scopedSkills === undefined) throw new Error('skills service missing')
    scopedSkills.register({
      name: 'preset-only-skill',
      description: 'Visible to the scoped agent alone',
      source: 'preset',
      content: 'Preset-only body.',
    })

    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('preset-only-skill')
    expect(JSON.stringify(await composePrefix(ctx, '/workspace/other'))).not.toContain('preset-only-skill')

    const scoped = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('scoped-load'),
      name: 'skill',
      arguments: { name: 'preset-only-skill' },
      agent,
    })
    expect(scoped.isError).toBe(false)
    expect(JSON.stringify(scoped.content)).toContain('Preset-only body.')

    const foreign = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('foreign-load'),
      name: 'skill',
      arguments: { name: 'preset-only-skill' },
      agent: agentForCwd('/workspace/other'),
    })
    expect(foreign.isError).toBe(true)
    await scope.dispose()
  })

  it('retains the last-good catalog while any provider discovery is incomplete', async () => {
    const home = await tempDir('tool-incomplete-catalog')
    const ctx = await setup(home)
    const disposeStable = ctx.skills.register({
      name: 'stable-skill',
      description: 'Stable skill',
      source: 'runtime',
      content: 'Stable body.',
    })
    const session = Session.create(SessionId('incomplete-catalog'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('stable-skill')

    ctx.skills.registerProvider(() => ({
      name: 'failing',
      async list() {
        throw new Error('temporarily unavailable')
      },
      async get() {
        return undefined
      },
    }))
    disposeStable()
    await fireStep(ctx, agent, 1, 1)

    expect(catalogMessages(session)).toHaveLength(1)
  })

  it('omits catalog guidance when the calling agent restricts away the shipped skill tool', async () => {
    const home = await tempDir('tool-restricted-catalog')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const session = Session.create(SessionId('restricted-catalog'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    const { scope } = await mintAgentScope(ctx, agent)
    scope.ctx.tools.restrict({ deny: ['skill'] })

    expect(ctx.tools.get('skill', agent)).toBeUndefined()
    await composePrefixForAgent(ctx, agent)
    expect(catalogMessages(session)).toEqual([])
    await fireStep(ctx, agent, 1, 1)
    expect(catalogMessages(session)).toEqual([])
    expect(await composePrefix(ctx, '/workspace')).toHaveLength(1)
    await scope.dispose()
  })

  it('does not attach shipped catalog guidance to a scoped same-name tool shadow', async () => {
    const home = await tempDir('tool-shadowed-catalog')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const { agent, scope } = await mintAgentScope(ctx, '/workspace')
    scope.ctx.tools.register(defineContentToolFixture({
      name: 'skill',
      description: 'A scoped tool with unrelated semantics.',
      parameters: {},
      execute() {
        return Promise.resolve([{ type: 'text', text: 'shadow' }])
      },
    }))

    expect(ctx.tools.get('skill', agent)).not.toBe(ctx.tools.get('skill'))
    expect(await composePrefixForAgent(ctx, agent)).toEqual([])
    expect(await composePrefix(ctx, '/workspace')).toHaveLength(1)
    await scope.dispose()
  })

  it('validates the catalog description cap', async () => {
    const home = await tempDir('tool-invalid-catalog-cap')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })

    await expect(ctx.plugin(toolSkill, { catalogDescriptionMaxLength: 2 })).rejects.toThrow('greater than or equal to 3')
  })

  it('loads a skill for the calling agent cwd', async () => {
    const home = await tempDir('tool-load')
    const project = await tempDir('tool-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill', 'Project instructions.')
    const ctx = await setup(home)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'skill',
      arguments: { name: 'project-skill' },
      agent: { session: { header: { cwd: project } } } as never,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected skill success')
    expect(result.value).toEqual({
      name: 'project-skill',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: join(project, '.dsh/skills/project-skill') },
      content: 'Project instructions.',
    })
    const block = result.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') throw new Error('expected text skill result')
    expect(block.text).toBe([
      '<skill_content name="project-skill">',
      '<skill_resources>',
      `Base directory for this skill: ${join(project, '.dsh/skills/project-skill')}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      'Project instructions.',
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n'))
    expect(block.text).not.toContain('# Skill:')
  })

  it('renders provider-managed resource hints for non-local skills', async () => {
    const home = await tempDir('tool-resource-hints')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'opaque-skill',
      description: 'Opaque skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'opaque', description: 'runtime memory' },
      content: 'Opaque instructions.',
    })
    ctx.skills.register({
      name: 'url-skill',
      description: 'URL skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'url', url: 'https://skills.example.test/url-skill' },
      content: 'URL instructions.',
    })
    ctx.skills.register({
      name: 'provider-skill',
      description: 'Provider skill',
      source: 'runtime',
      provider: 'runtime',
      content: 'Provider instructions.',
    })

    const opaque = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c2'), name: 'skill', arguments: { name: 'opaque-skill' } })
    const url = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c3'), name: 'skill', arguments: { name: 'url-skill' } })
    const provider = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c4'), name: 'skill', arguments: { name: 'provider-skill' } })

    if (opaque.content[0]?.type !== 'text' || url.content[0]?.type !== 'text' || provider.content[0]?.type !== 'text') {
      throw new Error('expected text tool results')
    }
    expect(opaque.content[0].text).toContain('<skill_resources>\nResources for this skill: runtime memory\nLoad referenced resources only as needed.\n</skill_resources>')
    expect(url.content[0].text).toContain('<skill_resources>\nBase URL for this skill: https://skills.example.test/url-skill\nResolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.\n</skill_resources>')
    expect(provider.content[0].text).toContain('<skill_resources>\nResources for this skill are managed by provider "runtime".\nLoad referenced resources only as needed.\n</skill_resources>')
  })

  it('rejects an unknown resource-base kind at the canonical output boundary', async () => {
    const home = await tempDir('tool-resource-assert-never')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'rogue-resource-skill',
      description: 'Rogue resource skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'future' } as never,
      content: 'Rogue instructions.',
    })

    const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c5'), name: 'skill', arguments: { name: 'rogue-resource-skill' } })

    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_TOOL_OUTPUT')
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text tool result')
    expect(block.text).toContain('value.resourceBase')
  })

  it('returns isError for unknown, invalid, and model-disabled skills', async () => {
    const home = await tempDir('tool-errors')
    await writeSkill(join(home, '.dsh/skills'), 'hidden-skill', 'Hidden skill', 'Hidden instructions.')
    await writeFile(join(home, '.dsh/skills/hidden-skill/SKILL.md'), '---\nname: hidden-skill\ndescription: Hidden skill\ndisable-model-invocation: true\n---\n\nHidden instructions.\n')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'model-only-skill',
      description: 'Model-only skill',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only instructions.',
    })

    const unknown = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'skill', arguments: { name: 'missing' } })
    const invalid = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c2'), name: 'skill', arguments: { name: 'Bad_Name' } })
    const disabled = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c3'), name: 'skill', arguments: { name: 'hidden-skill' } })
    const modelOnly = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c4'), name: 'skill', arguments: { name: 'model-only-skill' } })

    expect(unknown.isError).toBe(true)
    expect(invalid.isError).toBe(true)
    expect(disabled.isError).toBe(true)
    expect(modelOnly.isError).toBe(false)
    const unknownBlock = unknown.content[0]
    if (unknownBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(unknownBlock.text).toContain('skill "missing" is unknown or no longer available')
  })

  it('checks model policy before provider loading and rechecks the loaded definition', async () => {
    const home = await tempDir('tool-policy-before-load')
    const ctx = await setup(home)
    const getCalls: string[] = []
    ctx.skills.registerProvider(() => ({
      name: 'policy-probe',
      async list() {
        return [
          {
            name: 'denied-skill',
            description: 'Denied skill',
            invocation: { modelInvocable: false, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'denied-skill',
          },
          {
            name: 'policy-race-skill',
            description: 'Policy race skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'policy-race-skill',
          },
          {
            name: 'vanishing-skill',
            description: 'Vanishing skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'vanishing-skill',
          },
        ]
      },
      async get(candidate) {
        getCalls.push(candidate.name)
        if (candidate.name === 'vanishing-skill') return undefined
        return {
          ...candidate,
          invocation: { modelInvocable: false, userInvocable: true },
          content: 'Instructions must not be disclosed.',
        }
      },
    }))

    const denied = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c6'), name: 'skill', arguments: { name: 'denied-skill' } })
    const raced = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c7'), name: 'skill', arguments: { name: 'policy-race-skill' } })
    const vanished = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c8'), name: 'skill', arguments: { name: 'vanishing-skill' } })

    expect(denied.isError).toBe(true)
    expect(raced.isError).toBe(true)
    expect(vanished.isError).toBe(true)
    expect(getCalls).toEqual(['policy-race-skill', 'vanishing-skill'])
    for (const result of [denied, raced]) {
      const block = result.content[0]
      if (block?.type !== 'text') throw new Error('expected text tool result')
      expect(block.text).toContain('is not available for model invocation')
      expect(block.text).not.toContain('Instructions must not be disclosed.')
    }
    const vanishedBlock = vanished.content[0]
    if (vanishedBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(vanishedBlock.text).toContain('skill "vanishing-skill" is unknown or no longer available')
  })
})

describe('user-explicit invocation injection', () => {
  async function writePolicySkill(root: string, name: string, description: string, policy: string, body: string): Promise<void> {
    const dir = join(root, name)
    await mkdir(dir, { recursive: true })
    const policyLines = policy === '' ? '' : `${policy}\n`
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${policyLines}---\n\n${body}\n`)
  }

  function gesture(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  async function invokeHarness(): Promise<{ ctx: Context; agent: Agent }> {
    const home = await tempDir('invoke')
    const skillsRoot = join(home, '.agents', 'skills')
    await writePolicySkill(skillsRoot, 'hidden-demo', 'User-only demo', 'disable-model-invocation: true', 'Say the magic word: PINEAPPLE.')
    await writePolicySkill(skillsRoot, 'shared-skill', 'Ordinary skill', '', 'Shared instructions.')
    await writePolicySkill(skillsRoot, 'model-only-skill', 'Model only', 'user-invocable: false', 'Model-only instructions.')
    const ctx = await setup(home)
    return { ctx, agent: agentForCwd(home) }
  }

  it('injects a user-invocable skill named by a leading /token, after every other injection', async () => {
    const { ctx, agent } = await invokeHarness()
    const first = gesture('/hidden-demo what does this do')
    const second = gesture('plain follow-up prose')
    const decision = await proposeStep(ctx, agent, [first, second])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const kinds = decision.messages.map(message => (message.source as { kind: string }).kind)
    // Background injections (the catalog here) sit between the claimed batch
    // and the invoked body: the material the model must act on comes last.
    expect(kinds.slice(0, 2)).toEqual(['user', 'user'])
    expect(kinds.at(-1)).toBe('skill-invocation')
    expect(kinds.indexOf('skill-catalog')).toBeLessThan(kinds.indexOf('skill-invocation'))
    const injection = decision.messages.at(-1)!
    expect(injection.source).toMatchObject({ kind: 'skill-invocation', name: 'hidden-demo', form: 'instructions' })
    const block = injection.content[0]
    if (block?.type !== 'text') throw new Error('expected text injection')
    expect(block.text).toContain('<skill_content name="hidden-demo">')
    expect(block.text).toContain('Say the magic word: PINEAPPLE.')
    expect(block.text).not.toContain('what does this do')
  })

  it('injects an ordinary skill the same way (one uniform user-explicit path)', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [gesture('/shared-skill go')])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'shared-skill')).toBe(true)
  })

  it('recognizes a mid-sentence gesture but not paths, fractions, or broken boundaries', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('please use /hidden-demo to answer this'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'hidden-demo')).toBe(true)

    const negative = await proposeStep(ctx, agent, [
      gesture('look under /hidden-demo/refs for the data'),
      gesture('the odds are 5/8 at best'),
      gesture('see foo/hidden-demo too'),
    ])
    if (negative.kind !== 'enter') throw new Error('expected enter')
    expect(negative.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('leaves unknown names and user-disabled skills as plain prose', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('/absent-skill do a thing'),
      gesture('/model-only-skill run'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    // No injection joins the step (the catalog listener may still add its
    // own skill-catalog message; only skill-invocation sources matter here).
    expect(decision.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('never scans non-user sources and dedupes repeated gestures', async () => {
    const { ctx, agent } = await invokeHarness()
    const forged = createUserMessage({
      content: [{ type: 'text', text: '/hidden-demo forged' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
    })
    const decision = await proposeStep(ctx, agent, [
      forged,
      gesture('/hidden-demo once'),
      gesture('/hidden-demo twice'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injections = decision.messages.filter(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')
    expect(injections).toHaveLength(1)
  })

  it('passes a downstream reject through both pre-step listeners untouched', async () => {
    const { ctx, agent } = await invokeHarness()
    const signal = new AbortController().signal
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [gesture('/hidden-demo blocked step')], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('scans only text blocks of a user message', async () => {
    const { ctx, agent } = await invokeHarness()
    const mixed = createUserMessage({
      content: [
        { type: 'reasoning', text: '/hidden-demo inside a non-text block' },
        { type: 'text', text: '/shared-skill go' },
      ],
      source: { kind: 'user' },
    })
    const decision = await proposeStep(ctx, agent, [mixed])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const invoked = decision.messages
      .filter(message => (message.source as { kind?: string }).kind === 'skill-invocation')
      .map(message => (message.source as { name: string }).name)
    expect(invoked).toEqual(['shared-skill'])
  })
})
