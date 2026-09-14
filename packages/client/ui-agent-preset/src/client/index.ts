/**
 * Agent-preset surface plugin, browser half — three surfaces over one roster:
 * a chip on the new-session screen for the session about to start, a
 * read-only label in the session header, and a settings section that manages
 * the roster (copy, delete, default, and the way into a preset's own files).
 *
 * A running session keeps the composition it began with (the host refuses to
 * adopt an existing session under a different preset). That is what splits
 * the choice from the display: the hero chip is before-the-fact, while the
 * header only reports what a session already runs. The default preset is
 * edited where the roster is visible — the settings section's "make default"
 * — so General settings carries no duplicate control for the same field.
 */

// Type-only: pulls the Session Controller service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
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
import { AgentPresetSeatController } from './seat-store.ts'
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
export {
  draftBlocker, type AgentPresetSectionState, type CopyDraft, type PresetRow, type PresetView,
} from './section-store.ts'
export type { AgentPresetOption, AgentPresetSettingsState } from './settings-store.ts'
export { AGENT_PRESET_SETTINGS_NS, writeDefaultPreset } from './settings-store.ts'

/** Required services (cordis fiber inject). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.agentPresets', 'remote.settings',
]

/**
 * Mount the roster surfaces: hero chip, session-header label, settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new AgentPresetSettingsController(ctx)
  // One roster, three surfaces. The chip is registered in a later scope, so it
  // subscribes here rather than being reached from this one.
  const rosterReaders = new Set<() => void>()
  const section = new AgentPresetSectionController(ctx, () => {
    void controller.load()
    for (const read of rosterReaders) read()
  })

  ctx.effect(() => ctx.locale.register('settings.agentPreset', { zh, en }), 'ui-agent-preset: settings row dictionaries')

  ctx.effect(() => {
    // The roster is a live directory and the default is a settings field, so
    // both an external settings edit and a reconnect can move this row.
    const refresh = (): void => {
      void controller.load()
      // The section reads the same roster and marks the same default, so a
      // change made from either surface converges both.
      if (section.store.getSnapshot().status !== 'idle') void section.load()
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns !== AGENT_PRESET_SETTINGS_NS) return
        refresh()
      }),
      ctx.on('connection/reset', () => {
        refresh()
        for (const read of rosterReaders) read()
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
  let activeSeat: AgentPresetSeatController | undefined

  // The new-session chip and the header label: one controller, because the
  // staged choice belongs to the flow rather than to any one session.
  ctx.inject(['slots', 'conversation', 'sessions', 'uiWorkspace'], (scope: ClientContext) => {
    const seat = new AgentPresetSeatController(scope, () => {
      const state = scope.sessions.list.getSnapshot()
      return state.current === undefined ? undefined : state.byId[state.current]
    })
    activeSeat = seat
    const seatInjected = (): AgentPresetSeatInjected => ({
      hooks: { agentPresetSeat: seat.store },
      load: () => seat.load(),
      select: (id: string) => seat.select(id),
      introduced: () => { seat.introduced() },
    })

    const labelInjected = (): AgentPresetLabelInjected => ({
      hooks: { agentPresets: controller.store },
      load: () => controller.load(),
    })

    scope.effect(() => {
      // Connecting a workspace either creates a blank session or reuses one,
      // and either way the chip's pick predates it — so the stage is applied
      // when the session arrives, not when it was made.
      const stop = scope.sessions.list.subscribe(() => { void seat.apply() })
      // The chip opens on the deployment default, so a default changed from
      // the settings surface moves it too — otherwise the screen that starts
      // the next session keeps offering the previous default until a reload,
      // which is exactly the session the setting claims to govern. A staged
      // pick survives: `load()` prefers it over the refreshed fallback.
      const settingsMoved = scope.remote.$on('settings/document-updated', (ns) => {
        if (ns !== AGENT_PRESET_SETTINGS_NS) return
        void seat.load()
      })
      // Authoring writes a FILE, not a setting, so nothing on the wire
      // announces it — without this the screen that starts the next session
      // keeps offering the roster as it stood when the chip first loaded, and
      // a preset authored to be used is missing from the one place it is used.
      const readRoster = (): void => { void seat.load() }
      rosterReaders.add(readRoster)
      // Stage WITHOUT applying — the still-current running session would
      // refuse the swap and drop the stage — then start the session it lands
      // on: the chip's list-change applier composes the blank session the
      // workspace connect produces or reuses.
      creatorDraft = () => {
        if (!section.store.getSnapshot().showPicker) return
        // The introduce cue makes the chip announce the pick the user never
        // made on this screen — the stage happened back in settings.
        seat.stage('cordis', true)
        scope.uiWorkspace.startSession()
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
        stop()
        settingsMoved()
        rosterReaders.delete(readRoster)
        creatorDraft = undefined
        activeSeat = undefined
        chip()
        label()
      }
    }, 'ui-agent-preset: new-session chip and header label')
  })

  /** Capture the exact blank Session one Settings action may update. */
  const captureBlankSessionSync = (): ((id: string) => Promise<string | undefined>) => {
    const seat = activeSeat
    const sessionId = seat?.blankSessionId()
    return async (id: string) => {
      if (seat === undefined || sessionId === undefined || activeSeat !== seat) return undefined
      return await seat.syncBlankSession(sessionId, id)
    }
  }

  const sectionInjected = (): AgentPresetSectionInjected => ({
    hooks: { agentPresetSection: section.store },
    load: () => section.load(),
    view: (id: string) => section.view(id),
    closeView: () => { section.closeView() },
    beginCopy: (from: string) => { section.beginCopy(from) },
    cancelCopy: () => { section.cancelCopy() },
    setCopyId: (id: string) => { section.setCopyId(id) },
    setCopyName: (name: string) => { section.setCopyName(name) },
    confirmCopy: () => section.confirmCopy(),
    openLocation: (id: string) => section.openLocation(id),
    ...creatorDraft === undefined ? {} : { startCreatorDraft: creatorDraft },
    confirmDelete: (id: string | null) => { section.confirmDelete(id) },
    remove: () => section.remove(),
    makeDefault: (id: string) => section.makeDefault(id, captureBlankSessionSync()),
    setPickerVisible: (showPicker: boolean) => section.setPickerVisible(showPicker, captureBlankSessionSync()),
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
