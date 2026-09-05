/**
 * ui-skill browser half: source and keyed toolview registration +
 * locale dictionaries + source duplicate-name proof +
 * fiber-teardown removal (HMR safety) against the real InputTriggerService, then
 * the source behavior contract driven directly on the captured source with
 * real ClientSessionContext projections — sessionId addressing, the
 * session-keyed catalog cache (single-flight per key, scope-birth warm
 * prewarm, connection/reset clear), shared fuzzy name ranking, RPC-failure
 * rejection, pick → plain-text outcome (the plain-text-reference decision:
 * .agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md),
 * the synchronous
 * lexicon reads over the settled cache, and the reference codec's two
 * projections. Direct driving is deliberate: this spec owns only the
 * source's own contract.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply, inject } from '../src/client/index.ts'
import { SkillRow as SkillToolRow } from '../src/client/SkillRow.tsx'

type SkillRow = { name: string; description: string; whenToUse?: string; modelInvocable?: boolean }
type ListResult =
  | { ok: true; value: { skills: SkillRow[] } }
  | { ok: false; error: RemoteFailure }
type ListFn = (payload: object, signal?: AbortSignal) => Promise<ListResult>

interface PresentationCapture {
  slots: SlotRegistry
  dictionaries: Array<{ namespace: string; dictionaries: unknown }>
  localeDisposed: boolean
}

/** Provide the presentation registries and capture the plugin's registrations. */
function providePresentation(ctx: Context): PresentationCapture {
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
  const capture: PresentationCapture = {
    slots,
    dictionaries: [],
    localeDisposed: false,
  }
  ctx.provide('locale', {
    register(namespace: string, dictionaries: unknown) {
      capture.dictionaries.push({ namespace, dictionaries })
      return () => { capture.localeDisposed = true }
    },
    // Minimal bound-translate fake: zh dictionary lookup, key passthrough on miss.
    bind: () => (key: string) => key === 'menu.userOnly' ? '仅用户' : key,
  })
  return capture
}

/** Boot the plugin over fake slash/connection faces; returns the captured source and its ctx. */
async function bench(list: ListFn, addressed?: SessionId) {
  const ctx = new Context()
  let captured: InputTriggerSource | undefined
  ctx.provide('inputTriggers', { registerSource: (src: InputTriggerSource) => { captured = src; return () => {} } })
  ctx.provide('sessions', {
    subagentAddress: (id: SessionId) => id === addressed
      ? { parentSessionId: sid('parent'), childSessionId: id, mode: 'continuable' as const }
      : undefined,
  })
  const remote = new TestRemote(ctx, { skills: { list } })
  providePresentation(ctx)
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, source: captured!, remote }
}

const CATALOG: SkillRow[] = [
  { name: 'commit-helper', description: 'commit flow', modelInvocable: true },
  { name: 'code-review', description: 'review flow', whenToUse: 'reviews', modelInvocable: true },
  { name: 'deploy', description: 'deploy flow', modelInvocable: true },
]

const listOk = (skills: SkillRow[]): ListFn => () => Promise.resolve({ ok: true as const, value: { skills } })

/** Counting fake: records payloads, resolves the shared catalog. */
function countingList(skills: SkillRow[] = CATALOG) {
  const payloads: object[] = []
  const list: ListFn = (payload) => {
    payloads.push(payload)
    return listOk(skills)(payload)
  }
  return { list, payloads }
}

const sid = (id: string) => id as SessionId

const proj = (id: string): ClientSessionContext => ({ sessionId: sid(id) })

const req = (query: string, signal?: AbortSignal) =>
  ({ query, position: 'leading' as const, drilled: false, signal: signal ?? new AbortController().signal })

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['inputTriggers', 'sessions', 'slots', 'locale', 'remote', 'remote.skills'])
  })

  it('registers the dedicated skill row and its locale dictionaries', async () => {
    const ctx = new Context()
    ctx.provide('inputTriggers', { registerSource: () => () => {} })
    ctx.provide('sessions', { subagentAddress: () => undefined })
    new TestRemote(ctx, { skills: { list: listOk(CATALOG) } })
    const presentation = providePresentation(ctx)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = presentation.slots.entries('tool.call.toolview')[0]
    expect(entry?.options).toMatchObject({ key: 'skill' })
    expect(entry?.locale).toBe('skill')
    expect(entry?.component).toBe(SkillToolRow)
    expect(presentation.dictionaries).toEqual([{
      namespace: 'skill', dictionaries: {
        zh: {
          'row.title': 'Skill',
          'row.running': '正在加载 skill',
          'row.failed': 'skill 加载失败',
          'row.stopped': 'skill 加载已中止',
          'row.instructions': '说明',
          'row.inspect': '查看',
          'menu.userOnly': '仅用户',
        },
        en: {
          'row.title': 'Skill',
          'row.running': 'Loading skill',
          'row.failed': 'Skill load failed',
          'row.stopped': 'Skill load stopped',
          'row.instructions': 'Instructions',
          'row.inspect': 'Inspect',
          'menu.userOnly': 'user-only',
        },
      },
    }])
  })

  it('registers the "/" skill source; disposal frees the name (HMR safety)', async () => {
    const ctx = new Context()
    // InputTriggerService itself injects 'sessions'; the stub unblocks its fiber.
    ctx.provide('sessions', {})
    await ctx.plugin(InputTriggerService).await()
    new TestRemote(ctx, { skills: { list: listOk(CATALOG) } })
    const presentation = providePresentation(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const inputTriggers = ctx.get('inputTriggers') as InputTriggerService
    const rival = {
      trigger: '/' as const,
      name: 'skill',
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
    }
    // Live registration holds the (trigger, name) seat…
    expect(() => inputTriggers.registerSource(rival)).toThrow(/already registered/)
    // …and fiber teardown releases it.
    await fiber.dispose()
    expect(() => inputTriggers.registerSource(rival)).not.toThrow()
    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(presentation.localeDisposed).toBe(true)
  })
})

describe('candidates: sessionId addressing', () => {
  it('lists via {sessionId} and ranks case-insensitive subsequence matches with prefixes first', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    const items = await source.candidates(proj('s1'), req('co'))
    // Exact payload: session address only — no agent or transport vocabulary.
    expect(payloads).toEqual([{ sessionId: 's1' }])
    expect(items).toEqual([
      { name: 'commit-helper', description: 'commit flow' },
      { name: 'code-review', description: 'review flow' },
    ])
    const names = async (query: string) => (await source.candidates(proj('s1'), req(query))).map(c => c.name)
    // 'de' prefixes deploy and is a subsequence of code-review: the prefix ranks first.
    await expect(names('de')).resolves.toEqual(['deploy', 'code-review'])
    await expect(names('REV')).resolves.toEqual(['code-review'])
    await expect(names('zzz')).resolves.toEqual([])
  })

  it('rejects on a failed result (the slash shell owns the menu-side fold)', async () => {
    const { source } = await bench(() => Promise.resolve({
      ok: false, error: new RemoteError('gateway/internal', 'boom', {}),
    }))
    await expect(source.candidates(proj('s1'), req('co')))
      .rejects.toThrow('skills/list failed: gateway/internal: boom')
  })

  it('does not fetch Agent-bound skills for an addressed child', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list, sid('child'))
    await expect(source.candidates(proj('child'), req(''))).resolves.toEqual([])
    source.warm!(proj('child'))
    expect(payloads).toEqual([])
  })
})

describe('catalog cache', () => {
  it('re-polls on the same session filter locally: one RPC across keystrokes', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    await source.candidates(proj('s1'), req(''))
    const second = await source.candidates(proj('s1'), req('co'))
    expect(payloads).toHaveLength(1)
    expect(second).toEqual([
      { name: 'commit-helper', description: 'commit flow' },
      { name: 'code-review', description: 'review flow' },
    ])
    // A different session is its own key — one more RPC, not two.
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toEqual([{ sessionId: 's1' }, { sessionId: 's2' }])
  })

  it('single-flight: concurrent candidates on one cold key share one RPC', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    const [a, b] = await Promise.all([
      source.candidates(proj('s1'), req('dep')),
      source.candidates(proj('s1'), req('co')),
    ])
    expect(payloads).toHaveLength(1)
    expect(a).toEqual([{ name: 'deploy', description: 'deploy flow' }])
    expect(b).toHaveLength(2)
  })

  it('an aborted caller yields empty but leaves the shared fetch warm', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    const aborted = new AbortController()
    aborted.abort()
    await expect(source.candidates(proj('s1'), req('co', aborted.signal))).resolves.toEqual([])
    // The fetch settled into the cache: the next caller pays zero RPC.
    await expect(source.candidates(proj('s1'), req('co'))).resolves.toHaveLength(2)
    expect(payloads).toHaveLength(1)
  })

  it('a failed fetch does not poison the key: the next caller retries', async () => {
    let fail = true
    const payloads: object[] = []
    const { source } = await bench((payload) => {
      payloads.push(payload)
      return fail
        ? Promise.resolve({ ok: false as const, error: new RemoteError('gateway/internal', 'boom', {}) })
        : listOk(CATALOG)(payload)
    })
    await expect(source.candidates(proj('s1'), req(''))).rejects.toThrow('boom')
    fail = false
    await expect(source.candidates(proj('s1'), req(''))).resolves.toHaveLength(3)
    expect(payloads).toHaveLength(2)
  })

  it('the scope-birth warm prewarms the session key fire-and-forget', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    source.warm!(proj('s1'))
    await vi.waitFor(() => { expect(payloads).toHaveLength(1) })
    expect(payloads[0]).toEqual({ sessionId: 's1' })
    // The prewarmed key serves candidates with zero further RPC; other
    // sessions' keys stay untouched.
    await expect(source.candidates(proj('s1'), req(''))).resolves.toHaveLength(3)
    expect(payloads).toHaveLength(1)
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(2)
  })

  it('agent-preset/selected clears only the recomposed session', async () => {
    const { list, payloads } = countingList()
    const { source, remote } = await bench(list)
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(2)
    // The catalog a preset supplies is the preset's; the other session's
    // composition did not change, so its cached catalog still holds.
    remote.emit('agent-preset/selected', [sid('s1'), 'minimal'])
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(3)
    expect(payloads[2]).toEqual({ sessionId: 's1' })
  })

  it('connection/reset clears every cached session', async () => {
    const { list, payloads } = countingList()
    const { ctx, source } = await bench(list)
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(2)
    ctx.emit('connection/reset')
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(4)
  })
})

describe('lexicon', () => {
  it('is undefined before the session catalog settles and serves names after', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { source } = await bench(async (payload) => {
      await gate
      return listOk(CATALOG)(payload)
    })
    // Cold: nothing cached for the session.
    expect(source.lexicon!(proj('s1'))).toBeUndefined()
    const pending = source.candidates(proj('s1'), req(''))
    // In flight: still no synchronous snapshot.
    expect(source.lexicon!(proj('s1'))).toBeUndefined()
    release!()
    await pending
    expect(source.lexicon!(proj('s1'))).toEqual(['commit-helper', 'code-review', 'deploy'])
    // Another session's key is independent — cold until its own fetch.
    expect(source.lexicon!(proj('s2'))).toBeUndefined()
  })

  it('subscribeLexicon notifies on catalog settle and on invalidation, per session', async () => {
    const { list } = countingList()
    const { ctx, source } = await bench(list)
    const s1 = vi.fn()
    const s2 = vi.fn()
    source.subscribeLexicon!(proj('s1'), s1)
    source.subscribeLexicon!(proj('s2'), s2)
    await source.candidates(proj('s1'), req(''))
    expect(s1).toHaveBeenCalledTimes(1)
    expect(s2).not.toHaveBeenCalled()
    // Reset invalidates every cached session: each key notifies its own listeners.
    await source.candidates(proj('s2'), req(''))
    ctx.emit('connection/reset')
    expect(s1).toHaveBeenCalledTimes(2)
    expect(s2).toHaveBeenCalledTimes(2)
  })

  it('an unsubscribed lexicon listener stops receiving notifications', async () => {
    const { list } = countingList()
    const { source } = await bench(list)
    const listener = vi.fn()
    const off = source.subscribeLexicon!(proj('s1'), listener)
    off()
    await source.candidates(proj('s1'), req(''))
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('pick lands plain text', () => {
  it('onPick returns the literal /name text with a closing space', async () => {
    const { source } = await bench(listOk(CATALOG))
    const outcome = source.onPick({
      candidate: { name: 'commit-helper', description: 'commit flow' },
      session: proj('s1'),
      position: 'leading',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 4, draftRev: 7 },
    })
    expect(outcome).toEqual({ text: '/commit-helper ' })
  })

  it('keeps the legacy reference codec removed and stays out of adjudication', async () => {
    const { source } = await bench(listOk(CATALOG))
    // Determinism lives host-side (the pre-step gesture boundary), so the
    // source neither claims lines nor serializes reference markup.
    expect(source.codec).toBeUndefined()
    expect(typeof source.matchSpace).toBe('undefined')
    expect(typeof source.matchEnter).toBe('undefined')
  })
})

describe('user-only marking', () => {
  it('prefixes the description of candidates the model cannot invoke', async () => {
    const rows: SkillRow[] = [
      { name: 'shared-skill', description: 'both surfaces', modelInvocable: true },
      { name: 'user-only-skill', description: 'user surface only', modelInvocable: false },
    ]
    const { source } = await bench(listOk(rows))
    const candidates = await source.candidates(proj('s1'), req(''))
    expect(candidates).toEqual([
      { name: 'shared-skill', description: 'both surfaces' },
      { name: 'user-only-skill', description: '仅用户 · user surface only' },
    ])
  })
})
