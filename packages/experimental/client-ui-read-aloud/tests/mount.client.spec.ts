/** The optional namespace, its three slot entries, and the audio output follow Client plugin disposal. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ReadingPlan } from '@deepseek-ai/dsh-read-aloud/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { ReadAloudAction, type ReadAloudActionInjected } from '../src/client/ReadAloudAction.tsx'
import { ReadAloudNotice, type ReadAloudNoticeInjected } from '../src/client/ReadAloudNotice.tsx'
import { ReadAloudSettings, type ReadAloudSettingsInjected } from '../src/client/ReadAloudSettings.tsx'
import { inject, mountReadAloud } from '../src/client/mount.ts'
import { apply as hostApply } from '../src/index.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-read-aloud', descriptors: [] }
const sessionId = 's1' as SessionId, messageId = 'm1' as MessageId

vi.mock('../src/client/status.ts', () => ({
  observeStatus: () => ({
    state: createSnapshotStore({ state: 'ready', synthesis: { voices: ['low', 'high'], voice: 'low', sampleRate: 8000 } }),
    dispose: async () => {},
  }),
}))
afterEach(() => { vi.unstubAllGlobals() })

/** Check that one erased registry payload carries hooks and the named verbs. */
function face(value: Record<string, unknown> | undefined, ...verbs: string[]): Record<string, unknown> {
  assert(value !== undefined && typeof value['hooks'] === 'object')
  for (const verb of verbs) assert(typeof value[verb] === 'function')
  return value
}

async function fixture(plan: () => Promise<unknown>, fail = false) {
  const ctx = new Context(), unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  const requested: object[] = []
  const synthesize = vi.fn((request: object) => { requested.push(request); return (async function* () { yield { pcm: 'AAAA' } })() })
  type Saved = { ok: true; value: undefined } | { ok: false; error: Error }
  const configure = vi.fn(async (_selection: object): Promise<Saved> => ({ ok: true, value: undefined }))
  const audio = async function* (failure?: Error): AsyncGenerator<{ pcm: string }, void, undefined> {
    if (failure !== undefined) throw failure
    yield { pcm: 'AAAA' }
  }
  const sample = vi.fn((_request: object, _signal: AbortSignal) => audio())
  ctx.provide('remote.readAloud', { plan, synthesize, configure, sample })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    'conversation.input.overlay': { kind: 'list', scope: 'session' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  } } as never,
  () => null)
  if (fail) vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  const closed = vi.fn(async () => {})
  vi.stubGlobal('AudioContext', function AudioContext() {
    return { currentTime: 0, destination: {}, close: closed,
      createBuffer: (_channels: number, length: number, rate: number) =>
        ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
      createBufferSource: () => ({ connect() {}, start() {}, stop() {}, addEventListener() {} }) }
  })
  /** Call one entry's inject as the renderer does for a session-scoped slot. */
  type Slot = 'conversation.chat.assistant-actions' | 'conversation.input.overlay' | 'plugins.bundle.config'
  const injected = (slot: Slot, component: unknown) => {
    const entry = ctx.slots.entries(slot).find(candidate => candidate.component === component)
    return (entry?.inject as ((sessionId: SessionId) => Record<string, unknown>) | undefined)?.(sessionId)
  }
  const faces = () => ({
    action: face(injected('conversation.chat.assistant-actions', ReadAloudAction), 'toggle') as Record<string, unknown> & ReadAloudActionInjected,
    notice: face(injected('conversation.input.overlay', ReadAloudNotice), 'leave', 'dismissNotice') as Record<string, unknown> & ReadAloudNoticeInjected,
    settings: face(
      injected('plugins.bundle.config', ReadAloudSettings), 'signIn', 'configure', 'toggleSample', 'stopSample', 'dismissSampleNotice',
    ) as Record<string, unknown> & ReadAloudSettingsInjected,
  })
  return { ctx, unmount, synthesize, configure, sample, audio, requested, closed, faces }
}

const PLAN: ReadingPlan = { seq: 4, segments: [{ start: 0, end: 5 }], dispatchBelowMs: 1000, sampleRate: 8000, voice: 'low' }

it('registers the control, the notice, and the bundle details, and reads through the mounted Remote', async () => {
  hostApply()
  const b = await fixture(async () => ({ ok: true, value: PLAN }))
  try {
    await b.ctx.plugin({ inject: [...inject], apply: ctx => mountReadAloud(ctx, REMOTE) })
    expect(b.ctx.slots.entries('conversation.chat.assistant-actions').find(entry => entry.component === ReadAloudAction))
      .toMatchObject({ options: { id: 'read-aloud', order: 20 }, locale: 'read-aloud' })
    expect(b.ctx.slots.entries('plugins.bundle.config').find(entry => entry.component === ReadAloudSettings))
      .toMatchObject({ options: { key: '@deepseek-ai/dsh-read-aloud-bundle' }, locale: 'read-aloud' })
    const { action, notice, settings } = b.faces()
    expect(action.hooks.readAloudStatus.getSnapshot().state).toBe('ready')
    expect(settings.hooks.readAloudStatus).toBe(action.hooks.readAloudStatus)
    expect(notice.hooks.reader).toBe(action.hooks.reader)
    action.toggle(messageId)
    expect(action.hooks.reader.getSnapshot().reading).toEqual({ sessionId, messageId, phase: 'loading' })
    await vi.waitFor(() => { expect(b.requested).toEqual([{ sessionId, messageId, seq: 4, voice: 'low', start: 0, end: 5 }]) })
    await vi.waitFor(() => { expect(action.hooks.reader.getSnapshot().reading?.phase).toBe('playing') })
    notice.leave()
    expect(action.hooks.reader.getSnapshot().reading).toBeNull()
    expect(b.closed).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('turns a refused plan into a notice the Session can retire', async () => {
  const error = Object.assign(new Error('gone'), { isDSHRemoteError: true, code: 'readAloud/message-not-found', details: {} })
  const b = await fixture(async () => ({ ok: false, error }))
  try {
    await b.ctx.plugin({ inject: [...inject], apply: ctx => mountReadAloud(ctx, REMOTE) })
    const { action, notice } = b.faces()
    action.toggle(messageId)
    await vi.waitFor(() => { expect(action.hooks.reader.getSnapshot().notice).toMatchObject({ kind: 'failed', seq: 1 }) })
    notice.dismissNotice(1)
    expect(action.hooks.reader.getSnapshot().notice).toBeNull()
    expect(b.synthesize).not.toHaveBeenCalled()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('saves the voice and plays the audition through the mounted Remote', async () => {
  const b = await fixture(async () => ({ ok: true, value: PLAN }))
  try {
    await b.ctx.plugin({ inject: [...inject], apply: ctx => mountReadAloud(ctx, REMOTE) })
    const { action, settings } = b.faces()
    // Every rendering of the details receives the same verbs.
    expect(b.faces().settings).toBe(settings)
    expect(settings.hooks.reader).toBe(action.hooks.reader)
    await settings.configure('high')
    expect(b.configure).toHaveBeenCalledExactlyOnceWith({ voice: 'high' })
    const refused = new Error('offers no voice')
    b.configure.mockResolvedValueOnce({ ok: false, error: refused })
    await expect(settings.configure('nasal')).rejects.toBe(refused)
    settings.toggleSample({ voice: 'high', language: 'zh', sampleRate: 8000 })
    expect(settings.hooks.reader.getSnapshot().sample).toEqual({ voice: 'high', phase: 'loading' })
    await vi.waitFor(() => { expect(settings.hooks.reader.getSnapshot().sample?.phase).toBe('playing') })
    expect(b.sample.mock.calls[0]?.[0]).toEqual({ voice: 'high', language: 'zh' })
    settings.stopSample()
    expect(settings.hooks.reader.getSnapshot().sample).toBeNull()
    expect(b.closed).toHaveBeenCalledOnce()
    b.sample.mockImplementationOnce(() => b.audio(new Error('socket closed')))
    settings.toggleSample({ voice: 'high', language: 'zh', sampleRate: 8000 })
    await vi.waitFor(() => { expect(settings.hooks.reader.getSnapshot().sampleNotice).toMatchObject({ kind: 'failed' }) })
    settings.dismissSampleNotice(settings.hooks.reader.getSnapshot().sampleNotice!.seq)
    expect(settings.hooks.reader.getSnapshot().sampleNotice).toBeNull()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('follows the account sign-in entry and opens it only while present', async () => {
  const b = await fixture(async () => ({ ok: true, value: PLAN }))
  try {
    await b.ctx.plugin({ inject: [...inject], apply: ctx => mountReadAloud(ctx, REMOTE) })
    const { settings } = b.faces()
    expect(settings.hooks.accountSignIn.getSnapshot()).toBe(false)
    expect(() => { settings.signIn() }).not.toThrow()
    const open = vi.fn()
    const account = b.ctx.plugin({ apply: (ctx: Context) => { ctx.provide('accountSignIn', { open } as never) } })
    await account
    await vi.waitFor(() => { expect(settings.hooks.accountSignIn.getSnapshot()).toBe(true) })
    settings.signIn()
    expect(open).toHaveBeenCalledOnce()
    await account.dispose()
    expect(settings.hooks.accountSignIn.getSnapshot()).toBe(false)
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('stops the reading and withdraws its Remote and slot entries on disposal', async () => {
  const b = await fixture(async () => ({ ok: true, value: PLAN }))
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountReadAloud(ctx, REMOTE) })
    await fiber
    const { action } = b.faces()
    action.toggle(messageId)
    await fiber.dispose()
    expect(action.hooks.reader.getSnapshot().reading).toBeNull()
    expect(b.closed).toHaveBeenCalledOnce()
    expect(b.unmount).toHaveBeenCalledOnce()
    for (const slot of ['conversation.chat.assistant-actions', 'conversation.input.overlay', 'plugins.bundle.config'] as const) {
      expect(b.ctx.slots.entries(slot)).toHaveLength(0)
    }
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('withdraws the Remote when its UI cannot register', async () => {
  const b = await fixture(async () => ({ ok: true, value: PLAN }), true)
  try {
    await expect(b.ctx.plugin({ inject: [...inject], apply: ctx => mountReadAloud(ctx, REMOTE) })).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})
