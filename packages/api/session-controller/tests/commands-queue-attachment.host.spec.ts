import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { subagentIdentityProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/projection.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

async function commandHarness(
  childMode?: 'continuable' | 'seeded-continuable' | 'seed-only' | 'one-shot' | 'unknown' | 'corrupt',
): Promise<{
  ctx: Context
  controller: SessionCommandController
  agent: Agent
  inbox: Inbox
  steer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  const sessionId = SessionId('commands-session')
  const ancestor = Session.create(SessionId('ancestor'))
  ancestor.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'continuable', provider: 'test', label: 'ancestor',
  }))
  // A seeded child inherits exactly the ancestor prefix; its own descriptor
  // is appended after creation, as the continuation manager does. `seed-only`
  // never appends one: the identity folds as continuable, but from the
  // inherited prefix rather than this Session's own suffix.
  const lineage = childMode === 'seeded-continuable' || childMode === 'seed-only'
    ? ancestor.snapshotEvents()
    : undefined
  const session = ctx.sessions.create(sessionId, {
    ...lineage === undefined ? {} : { seed: lineage, inheritedEventCount: SessionLogOffset(lineage.length) },
    meta: {
      cwd: '/workspace',
      ...(childMode === undefined ? {} : {
        origin: 'subagent' as const,
        parentSession: SessionId('offline-parent'),
      }),
      ...lineage === undefined ? {} : { isSeeded: true },
    },
  })
  if (childMode === 'continuable' || childMode === 'seeded-continuable') {
    session.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable', provider: 'test', label: 'child',
    }))
  } else if (childMode === 'one-shot') {
    session.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'one-shot', provider: 'test', label: 'child',
    }))
  } else if (childMode === 'corrupt') {
    session.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 1,
    } as never)
  }
  const inbox = createInboxStub()
  const steer = vi.fn((message: UserMessage) => { inbox.append('next-step', message) })
  const cancel = vi.fn()
  const agent = {
    id: session.id,
    session,
    inbox,
    status: 'running',
    ctx,
    steer,
    followup: vi.fn(),
    cancel,
  } as unknown as Agent
  ctx.agents.register(agent)
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const selection: ModelSelectionRef = {
    current: { provider: 'fixture', model: 'fixture-model' },
    assembled: undefined,
  }
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    selectionFor: () => selection,
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
    composeAgent: () => Promise.resolve({ setup: () => {} }),
  } as unknown as ApiSessionAgentController
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    agent,
    inbox,
    steer,
    cancel,
  }
}

async function expectFailure(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code })
}

describe('Session queue commands', () => {
  it('edits, removes, steers, and rejects stale queue occurrences', async () => {
    const { ctx, controller, agent, inbox, steer, cancel } = await commandHarness()
    const queued = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
    const nextStep = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
    inbox.append('next-turn', queued)
    inbox.append('next-step', nextStep)

    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id,
      itemId: queued.id,
      action: {
        kind: 'edit',
        content: [{
          type: 'image',
          attachment: {
            attachmentId: AttachmentId('att-edit'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
          },
        }],
      },
    })), 'session/attachment-invalid')
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: SessionId('missing'), itemId: queued.id, action: { kind: 'remove' },
    })), 'session/queue-item-not-found')
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id, itemId: MessageId('missing'), action: { kind: 'remove' },
    })), 'session/queue-item-not-found')
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id, itemId: nextStep.id, action: { kind: 'steer' },
    })), 'session/steer-unavailable')

    Object.assign(agent, { status: 'idle' })
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id, itemId: queued.id, action: { kind: 'steer' },
    })), 'session/steer-unavailable')
    expect(controller.updateQueue({
      sessionId: agent.id,
      itemId: queued.id,
      action: { kind: 'edit', content: [{ type: 'text', text: 'edited' }] },
    })).toEqual({ accepted: true })
    expect(inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'edited' }])
    // An edit rewrites content in place, so the occurrence a client addressed
    // by id stays addressable.
    expect(inbox.nextTurn[0]?.id).toBe(queued.id)
    expect(controller.updateQueue({
      sessionId: agent.id, itemId: nextStep.id, action: { kind: 'remove' },
    })).toEqual({ accepted: true })

    Object.assign(agent, { status: 'running' })
    const steered = inbox.nextTurn[0]
    if (steered === undefined) throw new Error('missing edited queue item')
    expect(controller.updateQueue({
      sessionId: agent.id, itemId: steered.id, action: { kind: 'steer' },
    })).toEqual({ accepted: true })
    expect(steer).toHaveBeenCalledWith(steered)

    const queuedFile = createUserMessage({
      content: [{
        type: 'file',
        attachment: { attachmentId: AttachmentId('file-queued'), name: 'queued.txt', bytes: 6 },
      }],
      source: { kind: 'user', rpcId: 'file-rpc' as never },
    })
    inbox.append('next-turn', queuedFile)
    expect(controller.updateQueue({
      sessionId: agent.id, itemId: queuedFile.id, action: { kind: 'steer' },
    })).toEqual({ accepted: true })
    expect(steer).toHaveBeenLastCalledWith(queuedFile)
    expect(queuedFile).toMatchObject({
      source: { kind: 'user', rpcId: 'file-rpc' },
      content: [{ type: 'file', attachment: { name: 'queued.txt', bytes: 6 } }],
    })

    await expectFailure(Promise.resolve().then(() => controller.cancel({
      sessionId: SessionId('missing'),
    })), 'session/not-found')
    expect(controller.cancel({ sessionId: agent.id })).toEqual({ accepted: true })
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    await ctx.fiber.dispose()
  })

  it.each(['continuable', 'seeded-continuable'] as const)(
    'mutates both inbox destinations of a live %s child while its parent is offline',
    async (childMode) => {
      const { ctx, controller, agent, inbox, steer } = await commandHarness(childMode)
      const queued = createUserMessage({
        content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' },
      })
      const context = createUserMessage({
        content: [{ type: 'text', text: 'context' }], source: { kind: 'plugin', plugin: 'test' },
      })
      inbox.append('next-turn', queued)
      inbox.append('next-step', context)

      expect(controller.updateQueue({
        sessionId: agent.id,
        itemId: context.id,
        action: { kind: 'edit', content: [{ type: 'text', text: 'edited context' }] },
      })).toEqual({ accepted: true })
      const editedContext = inbox.nextStep[0]
      expect(editedContext).toMatchObject({
        content: [{ type: 'text', text: 'edited context' }],
        source: context.source,
      })
      expect(editedContext?.id).toBe(context.id)
      if (editedContext === undefined) throw new Error('missing edited context')
      expect(controller.updateQueue({
        sessionId: agent.id, itemId: editedContext.id, action: { kind: 'remove' },
      })).toEqual({ accepted: true })
      expect(controller.updateQueue({
        sessionId: agent.id, itemId: queued.id, action: { kind: 'steer' },
      })).toEqual({ accepted: true })
      expect(steer).toHaveBeenCalledWith(queued)
      await ctx.fiber.dispose()
    },
  )

  it('removes the selected message before handing it to Agent steering', async () => {
    const { ctx, controller, agent, inbox, steer } = await commandHarness('continuable')
    const first = createUserMessage({
      content: [{ type: 'text', text: 'first' }], source: { kind: 'user' },
    })
    const second = createUserMessage({
      content: [{ type: 'text', text: 'second' }], source: { kind: 'user' },
    })
    inbox.append('next-turn', first)
    inbox.append('next-turn', second)
    // Stand in for the Agent's cancellation-convergence destination; the
    // command must accept whichever boundary `Agent.steer()` selects.
    steer.mockImplementation((message: UserMessage) => { inbox.append('next-turn', message) })

    expect(controller.updateQueue({
      sessionId: agent.id, itemId: first.id, action: { kind: 'steer' },
    })).toEqual({ accepted: true })
    expect(steer).toHaveBeenCalledWith(first)
    // Ordering proves the removal happened before delivery rather than after.
    expect(inbox.nextTurn).toEqual([second, first])
    expect(inbox.nextStep).toEqual([])
    await ctx.fiber.dispose()
  })

  it('keeps one-shot, seed-only, missing, and malformed child descriptors behind the ownership fence', async () => {
    for (const mode of ['one-shot', 'seed-only', 'unknown', 'corrupt'] as const) {
      const { ctx, controller, agent, inbox } = await commandHarness(mode)
      const queued = createUserMessage({
        content: [{ type: 'text', text: mode }], source: { kind: 'user' },
      })
      inbox.append('next-turn', queued)
      await expectFailure(Promise.resolve().then(() => controller.updateQueue({
        sessionId: agent.id, itemId: queued.id, action: { kind: 'remove' },
      })), 'session/agent-busy')
      expect(inbox.nextTurn).toEqual([queued])
      await ctx.fiber.dispose()
    }
  })
})

function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  }
}

function event(type: string, seq: SessionSeq, data: unknown): SessionEvent {
  return { type, seq, time: seq + 1, data } as SessionEvent
}

async function persistedController(
  events: SessionEvent[],
  readImage: (ref: ImageAttachmentRef) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>,
): Promise<{ ctx: Context; controller: SessionCommandController; sessionId: SessionId }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const sessionId = SessionId('cold-attachment')
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    cwd: '/workspace',
    isSeeded: false,
  }
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([meta]),
    inspect: () => Promise.resolve({
      meta,
      inheritedEventCount: SessionLogOffset(0),
      events,
    }),
  }) as never)
  installSessionReadTestServices(ctx)
  ctx.provide('attachments', { readImage } as never)
  const agents = { resolveAgent: vi.fn() } as unknown as ApiSessionAgentController
  return { ctx, controller: new SessionCommandController(ctx, agents, '/workspace'), sessionId }
}

describe('Session attachment authorization', () => {
  it('finds references in direct, message, inserted, nested, and streamed content', async () => {
    const nested = imageRef('nested')
    const message = imageRef('message')
    const inserted = imageRef('inserted')
    const streamed = imageRef('streamed')
    const events = [
      { ...event('fixture/direct', SessionSeq(0), {
        content: [null, [], { type: 'tool-result', content: [{ type: 'text', text: 'none' }] }, {
          type: 'tool-result', content: [{ type: 'image', attachment: nested }],
        }],
      }), ignorable: true as const },
      { ...event('assistant/message', SessionSeq(1), {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [{ type: 'image', attachment: message }],
          source: { provider: 'fixture', model: 'fixture' },
        }),
      }), surfaceOp: 'append' as const },
      event('agent/inbox/spliced', SessionSeq(2), {
        target: 'next-turn',
        start: 0,
        inserted: [createUserMessage({
          content: [{ type: 'image', attachment: inserted }],
          source: { kind: 'user' },
        })],
      }),
      event('assistant/attempt', SessionSeq(3), {
        turn: 1,
        step: 1,
        stream: [
          {
            type: 'chunk',
            time: 3,
            chunk: { type: 'block-start', index: 0, blockType: 'text' },
          },
          {
            type: 'chunk',
            time: 3,
            chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
          },
        ],
      }),
      event('assistant/attempt', SessionSeq(4), {
        turn: 1,
        step: 1,
        stream: [{
          type: 'chunk',
          time: 4,
          chunk: { type: 'block-end', index: 0, block: { type: 'image', attachment: streamed } },
        }],
      }),
    ]
    const readImage = vi.fn((ref: ImageAttachmentRef) => Promise.resolve({ ref, data: Uint8Array.of(1) }))
    const { ctx, controller, sessionId } = await persistedController(events, readImage)

    for (const ref of [nested, message, inserted, streamed]) {
      await expect(controller.attachment({ sessionId, attachmentId: ref.attachmentId }))
        .resolves.toEqual({ attachment: ref, data: 'AQ==' })
    }
    expect(readImage).toHaveBeenCalledTimes(4)
    await ctx.fiber.dispose()
  })

  it('maps missing persistence identities and attachment backend failures', async () => {
    const noPersistence = new Context()
    await noPersistence.plugin(SessionStore)
    installSessionReadTestServices(noPersistence)
    const noPersistenceController = new SessionCommandController(
      noPersistence,
      { resolveAgent: vi.fn() } as unknown as ApiSessionAgentController,
      '/workspace',
    )
    await expectFailure(noPersistenceController.attachment({
      sessionId: SessionId('missing'), attachmentId: AttachmentId('att'),
    }), 'session/not-found')

    const missing = new Context()
    await missing.plugin(SessionStore)
    missing.provide('sessionPersistence', testSessionPersistence(missing, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    }) as never)
    installSessionReadTestServices(missing)
    const missingController = new SessionCommandController(
      missing,
      { resolveAgent: vi.fn() } as unknown as ApiSessionAgentController,
      '/workspace',
    )
    await expectFailure(missingController.attachment({
      sessionId: SessionId('missing'), attachmentId: 'att' as never,
    }), 'session/not-found')

    for (const thrown of [
      new AttachmentError('stored image is unavailable', 'ATTACHMENT_NOT_FOUND'),
      new Error('backend offline'),
    ]) {
      const ref = imageRef(`failure-${thrown.name}`)
      const fixture = await persistedController(
        [event('fixture/content', SessionSeq(0), { content: [{ type: 'image', attachment: ref }] })],
        () => Promise.reject(thrown),
      )
      await expectFailure(fixture.controller.attachment({
        sessionId: fixture.sessionId,
        attachmentId: ref.attachmentId,
      }), thrown instanceof AttachmentError ? 'session/attachment-invalid' : 'gateway/internal')
      await fixture.ctx.fiber.dispose()
    }
  })

  it('maps a cold observation failure to an internal authorization error', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('storage offline'))
    const controller = new SessionCommandController(
      ctx,
      { resolveAgent: vi.fn() } as unknown as ApiSessionAgentController,
      '/workspace',
    )

    await expectFailure(controller.attachment({
      sessionId: SessionId('unreadable'), attachmentId: AttachmentId('att'),
    }), 'gateway/internal')
    await ctx.fiber.dispose()
  })
})
