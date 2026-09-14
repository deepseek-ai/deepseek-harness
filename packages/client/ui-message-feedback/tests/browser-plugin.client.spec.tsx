// @vitest-environment jsdom
/**
 * ui-message-feedback browser half on a real cordis Context with fake slots/remote
 * faces: the plugin registers the feedback entry at
 * conversation.chat.assistant-actions and the dialog entry at
 * conversation.input.overlay, decorates the Host's /feedback command with an
 * action that opens the dialog, one surface per Session backs every entry in
 * that Session, a reconnect refreshes only Sessions that were already read,
 * and registration plus surface disposal ride the plugin fiber (HMR safety).
 * The node half stays inert.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type { MessageFeedbackItem, MessageFeedbackVersion } from '@deepseek-ai/dsh-message-feedback/types'
import type { CommandDecoration } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { FeedbackDialogInjected, MessageFeedbackInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId
const MSG = 'm-1' as MessageId

const seeded: MessageFeedbackItem = {
  messageId: MSG,
  rating: 'positive',
  version: 'v1' as MessageFeedbackVersion,
  createdAt: 1,
  updatedAt: 1,
}

/** Boot the plugin over fake faces; the Remote namespaces record every call. */
async function bench(options: { recordResult?: unknown; recordCarrier?: unknown } = {}) {
  const ctx = new Context()
  const calls: { method: string; request: unknown }[] = []
  // The generated face wraps every business result in the carrier envelope.
  const carried = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
  const messageFeedback = {
    list: (request: unknown) => {
      calls.push({ method: 'list', request })
      return carried({ ok: true as const, value: { items: [seeded] } })
    },
    put: (request: unknown) => {
      calls.push({ method: 'put', request })
      return carried({ ok: true as const, value: seeded })
    },
    delete: (request: unknown) => {
      calls.push({ method: 'delete', request })
      return carried({ ok: true as const, value: { absent: true as const } })
    },
  }
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  const sessionFeedback = {
    record: (request: unknown) => {
      calls.push({ method: 'record', request })
      if (options.recordCarrier !== undefined) return Promise.resolve(options.recordCarrier)
      return carried(options.recordResult ?? { ok: true as const, value: { recorded: true as const } })
    },
  }
  new RemoteService(ctx)
  ctx.provide('remote.messageFeedback', messageFeedback)
  ctx.provide('remote.sessionFeedback', sessionFeedback)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const decorations = new Map<string, CommandDecoration>()
  ctx.provide('commandUi', {
    decorate: (decoration: CommandDecoration) => {
      decorations.set(decoration.name, decoration)
      return () => { decorations.delete(decoration.name) }
    },
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls,
    decorations,
    entry: () => {
      const entry = ctx.slots.entries('conversation.chat.assistant-actions')[0]
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => MessageFeedbackInjected) | undefined,
      }
    },
    dialogEntry: () => {
      const entry = ctx.slots.entries('conversation.input.overlay')[0]
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => FeedbackDialogInjected) | undefined,
      }
    },
  }
}

describe('ui-message-feedback browser plugin', () => {
  it('registers the feedback entry with the documented id, order, and locale', async () => {
    const b = await bench()
    await b.fiber.await()

    expect(b.entry()).toMatchObject({ id: 'feedback', order: 10, locale: 'feedback' })
    expect(b.entry()?.inject).toBeTypeOf('function')
  })

  it('exposes the feedback hook plus the ensure/retract/openDialog verbs', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    expect(face.hooks.feedback.getSnapshot()).toMatchObject({ status: 'cold' })
    expect(face.ensure).toBeTypeOf('function')
    expect(face.current(MSG)).toBeUndefined()
    await face.ensure()
    expect(face.current(MSG)).toMatchObject({ messageId: MSG, rating: 'positive' })
    expect(face.retract).toBeTypeOf('function')
    expect(face.openDialog).toBeTypeOf('function')
  })

  it('registers the dialog entry with the documented id, order, and locale', async () => {
    const b = await bench()
    await b.fiber.await()

    expect(b.dialogEntry()).toMatchObject({ id: 'feedback-dialog', order: 2, locale: 'feedback' })
    const face = b.dialogEntry()!.inject!(sid('s1'))
    expect(face.hooks.dialog.getSnapshot()).toMatchObject({ target: null, toast: 0 })
    expect(face.dismissFailure).toBeTypeOf('function')
  })

  it('opens one dialog per Session from the message entry and the decoration', async () => {
    const b = await bench()
    await b.fiber.await()

    const message = b.entry()!.inject!(sid('s1'))
    const dialog = b.dialogEntry()!.inject!(sid('s1'))
    message.openDialog(MSG, 'positive')
    expect(dialog.hooks.dialog.getSnapshot().target).toEqual({ kind: 'message', messageId: MSG, rating: 'positive' })

    const decoration = b.decorations.get('feedback')
    expect(decoration?.available({ sessionId: sid('s1') })).toBe(true)
    if (decoration?.ui.kind !== 'action') throw new Error('the /feedback decoration is not an action')
    decoration.ui.run({ sessionId: sid('s1') })
    expect(dialog.hooks.dialog.getSnapshot().target).toEqual({ kind: 'session' })

    expect(b.dialogEntry()!.inject!(sid('s2')).hooks.dialog.getSnapshot()).toMatchObject({ target: null, toast: 0 })
  })

  it('records a Session remark through the sessionFeedback Remote and a message judgment through put', async () => {
    const b = await bench()
    await b.fiber.await()

    const message = b.entry()!.inject!(sid('s1'))
    const dialog = b.dialogEntry()!.inject!(sid('s1'))
    const decoration = b.decorations.get('feedback')
    if (decoration?.ui.kind !== 'action') throw new Error('the /feedback decoration is not an action')
    decoration.ui.run({ sessionId: sid('s1') })
    dialog.edit({ category: 'service-stability', text: 'timed out' })
    await dialog.submit()
    expect(b.calls.filter(call => call.method === 'record')[0]?.request)
      .toEqual({ sessionId: 's1', text: 'timed out', category: 'service-stability' })
    expect(dialog.hooks.dialog.getSnapshot()).toMatchObject({ target: null, toast: 1 })

    message.openDialog(MSG, 'positive')
    dialog.edit({ category: 'task-result' })
    await dialog.submit()
    expect(b.calls.filter(call => call.method === 'put')[0]?.request).toMatchObject({
      sessionId: 's1', messageId: MSG, rating: 'positive', category: 'task-result', ifVersion: 'v1',
    })
    expect(dialog.hooks.dialog.getSnapshot().toast).toBe(2)
    dialog.dismissToast(2)
    expect(dialog.hooks.dialog.getSnapshot().toast).toBe(0)
  })

  it('keeps the dialog open with the carrier code when the record call itself fails', async () => {
    const b = await bench({ recordCarrier: { ok: false as const, error: { code: 'gateway/internal', message: 'socket closed', details: {} } } })
    await b.fiber.await()
    const dialog = b.dialogEntry()!.inject!(sid('s1'))
    const decoration = b.decorations.get('feedback')
    if (decoration?.ui.kind !== 'action') throw new Error('the /feedback decoration is not an action')
    decoration.ui.run({ sessionId: sid('s1') })

    await dialog.submit()

    expect(dialog.hooks.dialog.getSnapshot()).toMatchObject({ target: { kind: 'session' }, failure: 'gateway/internal', toast: 0 })
    dialog.dismissFailure()
    expect(dialog.hooks.dialog.getSnapshot()).toMatchObject({ target: { kind: 'session' }, failure: null })
  })

  it('keeps the dialog open with the failure code when the Host rejects the remark', async () => {
    const b = await bench({
      recordResult: { ok: false as const, error: { code: 'session-not-found', sessionId: 'gone' } },
    })
    await b.fiber.await()
    const dialog = b.dialogEntry()!.inject!(sid('gone'))
    const decoration = b.decorations.get('feedback')
    if (decoration?.ui.kind !== 'action') throw new Error('the /feedback decoration is not an action')
    decoration.ui.run({ sessionId: sid('gone') })

    await dialog.submit()

    expect(dialog.hooks.dialog.getSnapshot()).toMatchObject({ target: { kind: 'session' }, failure: 'session-not-found' })
    dialog.dismiss()
    expect(dialog.hooks.dialog.getSnapshot().target).toBeNull()
  })

  it('shares one controller across every message in the same Session', async () => {
    const b = await bench()
    await b.fiber.await()

    const first = b.entry()!.inject!(sid('s1'))
    const second = b.entry()!.inject!(sid('s1'))
    expect(first.hooks.feedback).toBe(second.hooks.feedback)

    await first.ensure()
    await second.ensure()
    expect(b.calls.filter(call => call.method === 'list')).toHaveLength(1)
  })

  it('keeps separate Sessions on separate controllers', async () => {
    const b = await bench()
    await b.fiber.await()

    const one = b.entry()!.inject!(sid('s1'))
    const two = b.entry()!.inject!(sid('s2'))
    expect(one.hooks.feedback).not.toBe(two.hooks.feedback)

    await one.ensure()
    await two.ensure()
    expect(b.calls.filter(call => call.method === 'list').map(call => call.request)).toEqual([
      { sessionId: 's1' },
      { sessionId: 's2' },
    ])
  })

  it('routes only a matching retraction to the Remote', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    // A stale or opposite retraction is a no-op; only the matching rating
    // reaches delete, so this entry can never bypass the dialog through put.
    expect(await face.retract(MSG, 'negative')).toEqual({ ok: true })
    expect(await face.retract(MSG, 'positive')).toEqual({ ok: true })

    expect(b.calls.filter(call => call.method === 'put')).toHaveLength(0)
    expect(b.calls.filter(call => call.method === 'delete')[0]?.request).toMatchObject({
      sessionId: 's1', messageId: MSG,
    })
  })

  it('refreshes only Sessions already read when the connection resets', async () => {
    const b = await bench()
    await b.fiber.await()

    const warm = b.entry()!.inject!(sid('warm'))
    await warm.ensure()
    b.entry()!.inject!(sid('cold'))
    const before = b.calls.filter(call => call.method === 'list').length

    b.ctx.emit('connection/reset')
    await Promise.resolve()

    const reads = b.calls.filter(call => call.method === 'list')
    expect(reads).toHaveLength(before + 1)
    expect(reads.at(-1)?.request).toEqual({ sessionId: 'warm' })
  })

  it('withdraws the registrations and disposes surfaces with the plugin fiber', async () => {
    const b = await bench()
    await b.fiber.await()
    const face = b.entry()!.inject!(sid('s1'))
    const dialog = b.dialogEntry()!.inject!(sid('s1'))
    await face.ensure()
    face.openDialog(MSG, 'negative')

    await b.fiber.dispose()

    expect(b.ctx.slots.entries('conversation.chat.assistant-actions')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.input.overlay')).toHaveLength(0)
    expect(b.decorations.size).toBe(0)
    expect(dialog.hooks.dialog.getSnapshot().target).toBeNull()
    // A disposed controller refuses further mutations, so no request outlives the fiber.
    const before = b.calls.length
    expect(await face.retract(MSG, 'negative')).toMatchObject({ ok: false, error: { code: 'disposed' } })
    expect(b.calls).toHaveLength(before)
  })

  it('re-registers cleanly when the plugin is reloaded', async () => {
    const b = await bench()
    await b.fiber.await()
    await b.fiber.dispose()

    const reloaded = b.ctx.plugin({ inject: [...inject], apply })
    await reloaded.await()

    expect(b.ctx.slots.entries('conversation.chat.assistant-actions')).toHaveLength(1)
    expect(b.entry()).toMatchObject({ id: 'feedback' })
  })

  it('the node half applies without host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
