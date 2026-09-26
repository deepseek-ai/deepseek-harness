/**
 * Agent-preset surface plugin, browser half — three surfaces over one roster:
 * a chip on the new-session screen for the session about to start, a
 * read-only label in the session header, and a settings section that lists
 * the roster (selection, the new-task default, a read-only view of each
 * declared composition, and the way into Creator mode).
 *
 * A running session keeps the composition it began with (the host refuses to
 * adopt an existing session under a different preset). That is what splits
 * the choice from the display: the hero chip is before-the-fact, while the
 * header only reports what a session already runs. The default preset is
 * edited where the roster is visible — the settings section's "make default"
 * — so General settings carries no duplicate control for the same field.
 *
 * Developer tools (General settings) are the single gate over selection: with
 * them off the chip disappears and the card actions are disabled, while the
 * saved default keeps composing new sessions.
 */

// Type-only: pulls the Session Controller service merge (ctx.sessions).
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (the settings invalidation rides the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Workspace UI navigation service merge (ctx.uiWorkspace).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { AgentPresetLabel } from './AgentPresetLabel.tsx'
import type { AgentPresetLabelInjected } from './AgentPresetLabel.tsx'
import { AgentPresetSeat } from './AgentPresetSeat.tsx'
import type { AgentPresetSeatInjected } from './AgentPresetSeat.tsx'
import { AgentPresetSection } from './AgentPresetSection.tsx'
import type { AgentPresetSectionInjected } from './AgentPresetSection.tsx'
import { AgentPresetSeatController, type AgentPresetStage } from './seat-store.ts'
import { AgentPresetSectionController } from './section-store.ts'
import { en, zh, type AgentPresetSettingsKey } from './locales.ts'
import { AGENT_PRESET_SETTINGS_NS, AgentPresetSettingsController } from './settings-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent-preset surface copy. */
    'settings.agentPreset': AgentPresetSettingsKey
  }
}

export type { AgentPresetLabelInjected, AgentPresetLabelProps } from './AgentPresetLabel.tsx'
export type { AgentPresetSeatInjected, AgentPresetSeatProps } from './AgentPresetSeat.tsx'
export type { AgentPresetSectionInjected, AgentPresetSectionProps } from './AgentPresetSection.tsx'
export type { AgentPresetSeatState } from './seat-store.ts'
export type { AgentPresetSectionState, PresetView } from './section-store.ts'
export type { AgentPresetOption, AgentPresetSettingsState } from './settings-store.ts'
export { AGENT_PRESET_SETTINGS_NS, writeDefaultPreset } from './settings-store.ts'

/** Required services (cordis fiber inject). */
export const inject = [
  'slots', 'sessions', 'locale', 'remote', 'remote.agentPresets', 'remote.settings', 'configForms',
]

/**
 * Mount the roster surfaces: hero chip, session-header label, settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new AgentPresetSettingsController(ctx)
  const staged: AgentPresetStage = { id: undefined, introduce: false }
  const seats = new WeakMapWithValues<SessionBinding, AgentPresetSeatController>()
  const boundSeatDisposers = new Set<() => Promise<void>>()
  ctx.effect(() => async () => {
    await Promise.all([...boundSeatDisposers].map(dispose => dispose()))
  }, 'ui-agent-preset: bound selections')
  const unboundSeat = new AgentPresetSeatController(ctx, () => undefined, staged)
  const seatFor = (binding: SessionBinding): AgentPresetSeatController => {
    const existing = seats.get(binding)
    if (existing !== undefined) return existing
    const seat = new AgentPresetSeatController(ctx, () => {
      if (ctx.sessions.binding(binding.sessionId) !== binding) return undefined
      const summary = ctx.sessions.list.getSnapshot().byId[binding.sessionId]
      return summary !== undefined
        && (ctx.sessions.retainInfo(binding.sessionId).getSnapshot().retainedBy.mainView ?? 0) > 0
        ? summary
        : undefined
    }, staged)
    seats.set(binding, seat)
    const dispose = binding.ctx.effect(() => {
      const stop = ctx.sessions.list.subscribe(() => { void seat.apply() })
      return () => {
        stop()
        seats.delete(binding)
        boundSeatDisposers.delete(dispose)
      }
    }, 'ui-agent-preset: Provider binding')
    boundSeatDisposers.add(dispose)
    return seat
  }
  const section = new AgentPresetSectionController(ctx)
  // Turning Developer tools off clears the shared stage before any apply can compose it.
  const developerTools = ctx.configForms.developerTools.enabled
  ctx.effect(() => developerTools.subscribe(() => {
    if (developerTools.getSnapshot()) return
    staged.id = undefined
    staged.introduce = false
    void unboundSeat.apply()
    for (const seat of seats.values) void seat.apply()
  }), 'ui-agent-preset: Developer tools gate')
  const mainBlankSeat = (): AgentPresetSeatController | undefined => {
    const summary = Object.values(ctx.sessions.list.getSnapshot().byId)
      .find((session) => {
        /* v8 ignore next -- retained source counts omit zero-valued entries. */
        return session.blank && (session.retainedBy.mainView ?? 0) > 0
      })
    const binding = summary === undefined ? undefined : ctx.sessions.binding(summary.id)
    return binding === undefined ? undefined : seatFor(binding)
  }

  ctx.effect(() => ctx.locale.register('settings.agentPreset', { zh, en }), 'ui-agent-preset: settings row dictionaries')

  ctx.effect(() => {
    // The roster reflects live declarations and the default is a settings field, so
    // both an external settings edit and a reconnect can move this row.
    const refresh = (): void => {
      void controller.load()
      // The section reads the same roster and marks the same default, so a
      // change made from either surface converges both.
      if (section.store.getSnapshot().status !== 'idle') void section.load()
      void unboundSeat.load()
      for (const seat of seats.values) void seat.load()
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns !== AGENT_PRESET_SETTINGS_NS) return
        refresh()
      }),
      ctx.on('connection/reset', () => {
        refresh()
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-agent-preset: settings refresh')

  // The settings section's conversational authoring entry: stage the
  // self-referential preset and land a new session on it. Bound inside the
  // conversation scope below (the seat and the session flow live there) and
  // unbound with it, so the section's face reads the current binding per
  // render and simply hides the button while no flow exists.
  let creatorDraft: (() => void) | undefined
  ctx.inject(['slots', 'conversation', 'sessions', 'uiWorkspace'], (scope: ClientContext) => {
    const seatInjected = (sessionId: SessionId | undefined): AgentPresetSeatInjected => {
      const binding = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)
      const seat = binding === undefined ? unboundSeat : seatFor(binding)
      return {
        hooks: { agentPresetSeat: seat.store, developerTools: ctx.configForms.developerTools.enabled },
        load: () => seat.load(),
        select: (id: string) => seat.select(id),
        introduced: () => { seat.introduced() },
      }
    }

    const labelInjected = (): AgentPresetLabelInjected => ({
      hooks: { agentPresets: controller.store },
      load: () => controller.load(),
    })

    scope.effect(() => {
      creatorDraft = () => {
        const seat = mainBlankSeat() ?? unboundSeat
        seat.stage('cordis', true)
        scope.uiWorkspace.startSession()
        void seat.apply()
      }
      const chip = scope.slots.register({
        name: 'conversation.hero.agentPreset',
        locale: 'settings.agentPreset',
        inject: seatInjected,
      }, AgentPresetSeat)
      const label = scope.slots.register({
        name: 'conversation.session.header.actions',
        id: 'agent-preset',
        // Static session context occupies the header's leading negative-order band.
        order: -10,
        locale: 'settings.agentPreset',
        inject: labelInjected,
      }, AgentPresetLabel)
      return () => {
        creatorDraft = undefined
        chip()
        label()
      }
    }, 'ui-agent-preset: new-session chip and header label')
  })

  /** Capture the exact blank Session one Settings action may update. */
  const captureBlankSessionSync = (): ((id: string) => Promise<string | undefined>) => {
    const summary = Object.values(ctx.sessions.list.getSnapshot().byId)
      .find(session => session.blank && (session.retainedBy.mainView ?? 0) > 0)
    const binding = summary === undefined ? undefined : ctx.sessions.binding(summary.id)
    const seat = binding === undefined ? undefined : seatFor(binding)
    const sessionId = seat?.blankSessionId()
    return async (id: string) => {
      if (seat === undefined || sessionId === undefined || binding === undefined
        || seats.get(binding) !== seat) return undefined
      return await seat.syncBlankSession(sessionId, id)
    }
  }

  const sectionInjected = (): AgentPresetSectionInjected => ({
    hooks: { agentPresetSection: section.store, developerTools: ctx.configForms.developerTools.enabled },
    load: () => section.load(),
    view: (id: string) => section.view(id),
    closeView: () => { section.closeView() },
    ...creatorDraft === undefined ? {} : { startCreatorDraft: creatorDraft },
    makeDefault: (id: string) => section.makeDefault(id, captureBlankSessionSync()),
  })

  // Ordered after Models: choosing a model is routine, and composing an
  // agent is the deployment-shaping act behind it.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agent-presets',
    order: 20,
    label: () => ctx.locale.bind('settings.agentPreset')('nav'),
    locale: 'settings.agentPreset',
    inject: sectionInjected,
  }, AgentPresetSection))
}
