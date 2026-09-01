/**
 * Registration: the General row, the settings section, the new-session chip,
 * and the header label all come from one apply, and each defers until the slot
 * it fills has been declared. A pushed settings change refreshes the surfaces
 * that are already showing, so a default set from one converges the other.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { AgentPresetLabel } from '../src/client/AgentPresetLabel.tsx'
import type { AgentPresetLabelInjected } from '../src/client/AgentPresetLabel.tsx'
import { AgentPresetSection } from '../src/client/AgentPresetSection.tsx'
import type { AgentPresetSectionInjected } from '../src/client/AgentPresetSection.tsx'
import { AgentPresetSeat } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSeatInjected } from '../src/client/AgentPresetSeat.tsx'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'
import { apply as hostApply } from '../src/index.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); each bench stages zh explicitly on the locale instead.

const ROSTER_ONE = {
  ok: true as const,
  value: {
    presets: [{ id: 'standard', trust: 'system', isDefault: true }],
    authorable: true,
  },
}

/** The roster after this browser copied one preset of its own. */
const ROSTER_AUTHORED = {
  ok: true as const,
  value: {
    presets: [
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'mine', trust: 'user', isDefault: false },
    ],
    authorable: true,
  },
}

/** The same roster with a second preset carrying the default. */
const ROSTER_MOVED = {
  ok: true as const,
  value: {
    presets: [
      { id: 'standard', trust: 'system', isDefault: false },
      { id: 'minimal', trust: 'system', isDefault: true },
    ],
    authorable: true,
  },
}

async function bench() {
  const ctx = new Context()
  // The host's answer, mutable so a spec can move the default the way the
  // settings surface does and watch who re-reads it.
  let ROSTER: typeof ROSTER_ONE | typeof ROSTER_MOVED | typeof ROSTER_AUTHORED = ROSTER_ONE
  const moveDefault = (): void => { ROSTER = ROSTER_MOVED }
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const calls: string[] = []
  // The row reads `describe` to learn whether this browser may write at all,
  // and its default write is the one op this spec records.
  const settings = {
    canOpenAgentPresetDirectory: () => Promise.resolve({ ok: true as const, value: true }),
    describe: () => Promise.resolve({
      ok: true as const,
      value: { writable: true, hasDocument: true, namespaces: [] },
    }),
    update: (_ns: string, patch: unknown) => {
      calls.push(`settings:${JSON.stringify(patch)}`)
      return Promise.resolve({ ok: true as const, value: {} })
    },
    openAgentPresetDirectory: (agentPreset: string) => {
      calls.push(`openAgentPresetDirectory:${agentPreset}`)
      return Promise.resolve({ ok: true as const, value: { opened: true as const } })
    },
  }
  const remote = new TestRemote(ctx, { settings })
  // The roster and the switch are the AgentPresets Remote namespace; the
  // shared double carries no generated namespaces, so this spec stages its
  // own. Registered twice on purpose: the nested key satisfies the plugin's
  // `inject`, and the property is what `ctx.remote.agentPresets` reads,
  // because the double is a plain provided object rather than a Service.
  const agentPresets = {
    list: () => { calls.push('list'); return Promise.resolve(ROSTER) },
    read: () => Promise.resolve({
      ok: true as const,
      value: { agentPreset: 'standard', trust: 'system', content: '' },
    }),
    copy: (_from: string, id: string) => {
      calls.push(`copy:${id}`)
      // The host's roster now contains it, which is the whole point of the
      // copy and what every surface must converge on.
      ROSTER = ROSTER_AUTHORED
      return Promise.resolve({ ok: true as const, value: undefined })
    },
    deletePreset: () => Promise.resolve({ ok: true as const, value: undefined }),
    select: (_agentId: SessionId, agentPreset: string) => {
      calls.push(`select:${agentPreset}`)
      return Promise.resolve({ ok: true as const, value: agentPreset })
    },
  }
  ctx.provide('remote.agentPresets', agentPresets as never)
  Object.assign(remote, { agentPresets })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, calls, moveDefault, remote }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.general.item': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      conversation: { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
}

/** The conversation's own declarations, which the chip and label wait for. */
function declareConversation(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'conversation',
    children: {
      'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

/** A Workspace UI double recording new-session starts. */
function uiWorkspaceDouble() {
  const starts: unknown[] = []
  return {
    starts,
    startSession: (workspaceId?: unknown) => { starts.push(workspaceId ?? null) },
  }
}

/** A sessions double whose list can be moved and whose changes are pushed. */
function sessionsDouble(state: {
  current?: string
  byId: Record<string, {
    id: string
    blank: boolean
    projectionValues?: { agentPreset?: string | null }
  }>
}) {
  const listeners = new Set<() => void>()
  return {
    list: {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    /** Push a list change the way the runtime's store does. */
    notify: () => { for (const fn of listeners) fn() },
  }
}

describe('ui-agent-preset apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.agentPresets', 'remote.settings',
    ])
  })

  it('registers the settings section and no General row', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    // The default preset is edited in the section, where the roster is
    // visible; a General row would duplicate the same settings field.
    expect(slots.entries('settings.general.item')).toHaveLength(0)
    const section = slots.entries('settings.section')[0]!
    expect(section.component).toBe(AgentPresetSection)
    expect(section.options).toMatchObject({ id: 'agent-presets', order: 20 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('Agent 预设')
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('hands the section its own store and default write', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()

    await section.makeDefault('standard')
    expect(section.hooks.agentPresetSection.getSnapshot().rows)
      .toEqual([{ id: 'standard', trust: 'system', isDefault: true }])
  })

  it('routes the section actions to one controller', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()

    await section.load()
    section.beginCopy('standard')
    section.cancelCopy()
    section.beginCopy('standard')
    section.setCopyId('mine')
    section.setCopyName('我的模式')
    await section.confirmCopy()
    await section.view('standard')
    section.closeView()
    section.confirmDelete('mine')
    await Promise.all([section.openLocation('mine'), section.remove()])

    // One controller behind every action: the copy the dialog named is the
    // one the roster re-read reflects, and the delete the section confirmed
    // is the one its remove() sees.
    expect(calls).toContain('copy:mine')
    expect(calls.filter(call => call === 'openAgentPresetDirectory:mine').length).toBeGreaterThan(0)
    expect(section.hooks.agentPresetSection.getSnapshot().rows).toHaveLength(2)
  })

  it('refreshes a showing surface when its namespace changes, and ignores others', async () => {
    const { ctx, slots, calls, remote } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    const before = calls.length

    remote.emit('settings/document-updated', ['agent-presets', 1])
    await vi.waitFor(() => { expect(calls.length).toBe(before + 2) })
    const afterRelevant = calls.length

    remote.emit('settings/document-updated', ['llm-deepseek', 1])
    await Promise.resolve()

    // Both surfaces re-read on their own namespace; an unrelated one moves
    // neither, so this rules out a blanket refresh on every settings write.
    expect(calls.length).toBe(afterRelevant)
  })

  it('re-reads both surfaces when the connection comes back', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    const before = calls.length

    ctx.emit('connection/reset')

    // A reconnect can land on a host whose roster changed under the browser.
    await vi.waitFor(() => { expect(calls.length).toBe(before + 2) })
  })

  it('leaves the section alone until it has been opened once', async () => {
    const { ctx, slots, calls, remote } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const before = calls.length

    remote.emit('settings/document-updated', ['agent-presets', 1])
    await vi.waitFor(() => { expect(calls.length).toBeGreaterThan(before) })

    // Only the header label's roster reloads: a section nobody opened has
    // nothing to converge, and reading the roster for it would be wasted.
    expect(calls.length - before).toBe(1)
  })

  it('registers the new-session chip and the header label, and drops both on disposal', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({ byId: {} }) as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    const fiber = ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply })
    await fiber.await()

    const chip = slots.entries('conversation.hero.agentPreset')[0]!
    expect(chip.component).toBe(AgentPresetSeat)
    const label = slots.entries('conversation.session.header.actions')[0]!
    expect(label.component).toBe(AgentPresetLabel)
    expect(label.options).toMatchObject({ id: 'agent-preset', order: -10 })
    await fiber.dispose()
    expect(slots.entries('conversation.hero.agentPreset')).toHaveLength(0)
    expect(slots.entries('conversation.session.header.actions')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    conversation()
  })

  it('moves the chip when the default changes on the settings surface', async () => {
    const { ctx, slots, moveDefault, remote } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({ byId: {} }) as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()

    const chip = slots.entries('conversation.hero.agentPreset')[0]!
    const seat = (chip.inject as unknown as () => AgentPresetSeatInjected)()
    await seat.load()
    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('standard')

    // The chip opens on the deployment default, and the setting it comes from
    // lives on another screen: without this the next session — the very one
    // the setting governs — would be composed from the previous default until
    // a reload.
    // An unrelated namespace moves nothing: the chip re-reads on its own
    // setting, not on every settings write in the process.
    moveDefault()
    remote.emit('settings/document-updated', ['llm-deepseek', 1])
    await Promise.resolve()
    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('standard')

    remote.emit('settings/document-updated', ['agent-presets', 1])
    await vi.waitFor(() => {
      expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('minimal')
    })
    conversation()
  })

  it('offers a just-authored preset on the new-session chip', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({ byId: {} }) as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()

    const chip = slots.entries('conversation.hero.agentPreset')[0]!
    const seat = (chip.inject as unknown as () => AgentPresetSeatInjected)()
    await seat.load()
    expect(seat.hooks.agentPresetSeat.getSnapshot().options.map(option => option.id)).toEqual(['standard'])

    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    section.beginCopy('standard')
    section.setCopyId('mine')
    section.setCopyName('我的模式')
    await section.confirmCopy()

    // Authoring copies a directory rather than writing a setting, so nothing
    // on the wire announces it: a preset created to be used must appear on
    // the one screen that starts sessions, without a reload.
    await vi.waitFor(() => {
      expect(seat.hooks.agentPresetSeat.getSnapshot().options.map(option => option.id)).toEqual(['standard', 'mine'])
    })
    conversation()
  })

  it('applies the staged choice to the blank session the flow lands on', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state: {
      current?: string
      byId: Record<string, {
        id: string
        blank: boolean
        projectionValues?: { agentPreset?: string | null }
      }>
    } = { byId: {} }
    const sessions = sessionsDouble(state)
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const chip = (slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as () => AgentPresetSeatInjected)()

    await chip.load()
    // Picked on the hero screen, where there is no session yet.
    await chip.select('minimal')
    expect(calls).not.toContain('select:minimal')

    state.current = 's1'
    state.byId['s1'] = {
      id: 's1', blank: true, projectionValues: { agentPreset: 'standard' },
    }
    sessions.notify()

    // Connecting a workspace produced the session; the stage reaches it there.
    await vi.waitFor(() => { expect(calls).toContain('select:minimal') })
  })

  it('applies the stage to a session that records no preset of its own', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const sessions = sessionsDouble({
      current: 's1',
      byId: { s1: { id: 's1', blank: true } },
    })
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const chip = (slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as () => AgentPresetSeatInjected)()

    await chip.load()
    await chip.select('minimal')

    // A session created before the deployment composed presets records none;
    // reading that as "already runs it" would drop the pick on the floor.
    expect(calls).toContain('select:minimal')
  })

  it('forgets the stage once it has been spent', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state = {
      current: 's1',
      byId: {
        s1: { id: 's1', blank: true, projectionValues: { agentPreset: 'standard' } },
      },
    }
    const sessions = sessionsDouble(state)
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const chip = (slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as () => AgentPresetSeatInjected)()

    await chip.load()
    await chip.select('minimal')
    const spent = calls.filter(call => call === 'select:minimal').length
    sessions.notify()
    sessions.notify()

    // Every later list movement would re-apply a stage that was not cleared,
    // switching sessions the user never picked for.
    await Promise.resolve()
    expect(calls.filter(call => call === 'select:minimal')).toHaveLength(spent)
  })

  it('loads the header label from the shared roster store', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({ byId: {} }) as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const label = (slots.entries('conversation.session.header.actions')[0]!
      .inject as unknown as () => AgentPresetLabelInjected)()

    await label.load()

    expect(label.hooks.agentPresets.getSnapshot().options).toEqual([{ id: 'standard', trust: 'system' }])
  })

  it('stages the creator preset and starts a session from the section', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({ byId: {} }) as never)
    const uiWorkspace = uiWorkspaceDouble()
    ctx.provide('uiWorkspace', uiWorkspace as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    const seat = (slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as () => AgentPresetSeatInjected)()

    section.startCreatorDraft?.()

    // The pick is staged on the chip's own controller — the session the
    // workspace start produces is what the stage lands on — and exactly one
    // new-session flow began.
    expect(section.startCreatorDraft).toBeDefined()
    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('cordis')
    expect(uiWorkspace.starts).toHaveLength(1)

    // A cross-screen stage carries the introduce cue; the chip acknowledges
    // it once, and a repeat acknowledgement leaves the snapshot untouched.
    expect(seat.hooks.agentPresetSeat.getSnapshot().introduce).toBe(true)
    seat.introduced()
    const acknowledged = seat.hooks.agentPresetSeat.getSnapshot()
    expect(acknowledged.introduce).toBe(false)
    seat.introduced()
    expect(seat.hooks.agentPresetSeat.getSnapshot()).toBe(acknowledged)
    conversation()
  })

  it('keeps the applied composition when the roster load lands late', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state: {
      current?: string
      byId: Record<string, {
        id: string
        blank: boolean
        projectionValues?: { agentPreset?: string | null }
      }>
    } = { byId: {} }
    const sessions = sessionsDouble(state)
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    const seat = (slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as () => AgentPresetSeatInjected)()

    section.startCreatorDraft?.()
    state.current = 's1'
    state.byId['s1'] = { id: 's1', blank: true }
    sessions.notify()
    await vi.waitFor(() => { expect(calls).toContain('select:cordis') })

    // The chip mounts with the flow's session, so its roster load can land
    // AFTER the stage was consumed; the session's own composition is what
    // the display must keep — not the deployment default.
    state.byId['s1'] = {
      id: 's1', blank: true, projectionValues: { agentPreset: 'cordis' },
    }
    await seat.load()

    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('cordis')
    conversation()
  })

  it('offers no creator draft while the conversation flow is absent', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    // No conversation scope mounted: the face omits the affordance and the
    // section hides its button rather than staging into nowhere.
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    expect(section.startCreatorDraft).toBeUndefined()
  })
})

describe('AgentPresetSeatController reconciliation', () => {
  it('uses the deployment default without a Session and clears it for an uncomposed Session', async () => {
    const state: { current?: { id: SessionId; blank: boolean } } = {}
    const controller = new AgentPresetSeatController({
      remote: {
        agentPresets: {
          list: () => Promise.resolve(ROSTER_ONE),
        },
      },
    } as never, () => state.current)

    await controller.load()
    await controller.apply()
    expect(controller.store.getSnapshot().current).toBe('standard')

    state.current = { id: SessionId('uncomposed'), blank: true }
    await controller.apply()
    expect(controller.store.getSnapshot().current).toBe('')
  })

  it('restores an empty current value after a refused switch for an uncomposed Session', async () => {
    const select = () => Promise.resolve({
      ok: false as const, error: new RemoteError('gateway/internal', 'selection rejected', {}),
    })
    const controller = new AgentPresetSeatController({
      remote: { agentPresets: { select } },
    } as never, () => ({ id: SessionId('uncomposed'), blank: true }))

    await controller.select('minimal')

    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false, current: '', error: 'selection rejected',
    })
  })

  it('keeps the bare cause of a mount failure, not the frame that names the preset again', async () => {
    const reason = 'failed to import loader entry ctx (@deepseek-ai/dsh-gone): Cannot find package'
    const controller = new AgentPresetSeatController({
      remote: {
        agentPresets: {
          select: () => Promise.resolve({
            ok: false as const,
            error: new RemoteError(
              'agent-preset/invalid',
              `agent-presets: preset "broken" failed to mount: ${reason}`,
              { agentPreset: 'broken', reason },
            ),
          }),
        },
      },
    } as never, () => ({ id: SessionId('uncomposed'), blank: true }))

    // The surface reporting this names the preset itself, so carrying the
    // roster's own "preset X failed to mount" frame would say it twice.
    expect(await controller.select('broken')).toBe(reason)
    expect(controller.store.getSnapshot().error).toBe(reason)
  })
})
