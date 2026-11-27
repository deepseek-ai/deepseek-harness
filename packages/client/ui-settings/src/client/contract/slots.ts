/**
 * Settings slot contract — the canonical home of every settings slot type,
 * owned by the settings domain base rather than by the shell that renders
 * them (ui-settings-general, which occupies `sidebar.settings`). The shell has
 * zero copy of its own: ALL text (trigger label, panel title, header actions,
 * close aria, section content) arrives from registrants. A feature owns its
 * own settings pages — adding a setting never means editing the shell; copy
 * that belongs to no single feature (chrome, the General section) is owned by
 * ui-settings-general too.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots/client'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotFactoryMap {
    /**
     * One `settings.section` entry, rendered wherever a surface shows that
     * page: the Settings panel and the Plugins page. Props: `id` (the entry's
     * id) and `close` (the surface's leave action, passed to the entry).
     * Registered by the settings shell, which therefore declares
     * `settings.section`.
     */
    'settings.section.view': {
      scope: 'root'
      props: SettingsSectionViewProps
      children: { 'settings.section': { kind: 'list'; scope: 'root' } }
    }
  }

  interface SlotMap {
    /** Optional sidebar account launcher; opens the shell-owned settings panel. */
    'settings.launcher': { kind: 'single'; scope: 'root'; owner: SettingsLauncherOwnerProps }
    /**
     * Optional content anchored above the launcher row at the launcher row's
     * full width. The row takes no height, so the content floats over the
     * sidebar list; the shell hides it in the rail without unmounting it.
     */
    'settings.notice': { kind: 'single'; scope: 'root'; owner: SettingsNoticeOwnerProps }

    /**
     * The sidebar-foot trigger row content: icon + label, supplied as slot
     * content (the accessible name comes from the content — rail state
     * renders the label visually hidden). The shell renders the button
     * chrome and owns open state. Absent contribution degrades to an
     * icon-only button without an accessible name (broken-composition state;
     * the shipped composition always registers the seat).
     */
    'settings.trigger': { kind: 'single'; scope: 'root'; owner: SettingsTriggerOwnerProps }
    /**
     * The panel title text seat. Content renders inside the nav heading row;
     * the dialog's accessible name points at that node via aria-labelledby.
     * Absent contribution leaves the heading empty.
     */
    'settings.header': { kind: 'single'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /**
     * Optional actions rendered in the content-column header before Close.
     * Registrants own visibility, behavior, copy, and failure presentation;
     * the shell supplies only the ordered render site.
     */
    'settings.action': { kind: 'list'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /**
     * The close button's visually-hidden label text (the button itself —
     * icon, geometry, focus — is shell chrome). Absent contribution leaves
     * the button without an accessible name (broken-composition state).
     */
    'settings.close': { kind: 'single'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /**
     * One settings page per list entry, rendered through the
     * `settings.section.view` Factory. Settings lists every entry in its
     * navigation; the Plugins page also shows an entry on the listed bundle row
     * (or bundle) whose module is the registering package, when that row (or
     * bundle) registers no configuration of its own. Registrant options carry the nav
     * identity: `id` (section key, drives `only` filtering), `order` (nav
     * position), `label` (registrant-localized display text, usually a thunk
     * that each projection re-reads on locale change). An entry renders
     * wherever a caller renders `settings.section.view` with its id.
     * General Settings hosts the `settings.general.group` list; each group
     * owns its content and any child preference slots.
     */
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
    /**
     * Optional navigation icons addressed by the matching settings.section id.
     * The registration id must equal the target section's id; unmatched ids
     * never render. The icon's label option is not displayed.
     * The shell owns the button and label and keeps its default glyph when
     * no icon is registered for that id.
     */
    'settings.section.icon': { kind: 'list'; scope: 'root'; inline: true; owner: SettingsSectionIconOwnerProps }
    /**
     * Root-scoped onboarding steps contributed by settings features. The
     * shell mounts one ordered step at a time; the active registrant either
     * completes itself or keeps ownership until the user completes its sole
     * path. Registrants own readiness, copy, dialog behavior, AND visible
     * chrome: a step wraps its visible content in its modal surface (including
     * `#root` inert ownership) and renders null while private facts are still
     * loading. The shell paints no chrome of its own, so a mounted-but-deciding
     * step shows and blocks nothing.
     */
    'settings.onboarding': { kind: 'list'; scope: 'root'; owner: SettingsOnboardingOwnerProps }
    /**
     * One titled group in General Settings. Options carry its unique id,
     * localized label, and order. The page owns the enclosing card; the
     * registrant owns content and any child item-slot declarations.
     */
    'settings.general.group': { kind: 'list'; scope: 'root'; owner: SettingsGeneralGroupOwnerProps }
    /** Session and work-step display preferences. */
    'settings.general.group.display.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Sending behavior, shortcuts, and link preferences. */
    'settings.general.group.interaction.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Notification preferences contributed by available providers. */
    'settings.general.group.notifications.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Data and Session-log preferences. */
    'settings.general.group.data.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Release and update information. */
    'settings.general.group.updates.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /**
     * Legacy additive preferences in the default Preferences group. Options carry
     * the unique row id and order; registrants own copy, state, and mutations.
     * Register here when no explicit group is needed. The default group owns
     * this declaration, preserving existing plugin registrations.
     */
    'settings.general.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
  }
}
/** Built-in group item slots; custom groups declare their own SlotMap keys. */
export type SettingsGeneralGroupItemSlot =
  | 'settings.general.group.display.item'
  | 'settings.general.group.interaction.item'
  | 'settings.general.group.notifications.item'
  | 'settings.general.group.data.item'
  | 'settings.general.group.updates.item'

/** A group receives no owner data; labels and ordering live on its registration. */
export interface SettingsGeneralGroupOwnerProps {
  /** Marker field: group owner props are intentionally empty. */
  children?: never
}

/** Owner share of a General preference row (the section supplies nothing). */
export interface SettingsGeneralItemOwnerProps {
  /** Marker field: item owner props are intentionally empty. */
  children?: never
}

/** Caller props of the `settings.section.view` Factory. */
export interface SettingsSectionViewProps {
  /** The `settings.section` entry id to render. */
  id: string
  /** The rendering surface's leave action. */
  close: () => void
}

/** Owner share of the trigger content seat: the sidebar column state. */
export interface SettingsTriggerOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail, icon only). */
  wide: boolean
}

/** Owner share of the header title seat (the shell supplies nothing). */
export interface SettingsHeaderOwnerProps {
  /** Marker field: header owner props are intentionally empty. */
  children?: never
}

/**
 * Owner share of a settings section entry. The shell owns modal visibility
 * and navigation; a section's data arrives through its own inject faces and
 * stores. `close` is the one shell affordance a section receives, for flows
 * that leave settings altogether (starting a session from a section) — the
 * onboarding coordinator's `openSection`/`complete` precedent, inverted.
 */
export interface SettingsSectionOwnerProps {
  /** Leave the page: close the settings panel, or on the Plugins page return to the view the page was opened from. */
  close: () => void
}

/** Icon presentation supplied by the settings navigation row. */
export interface SettingsSectionIconOwnerProps {
  /** Requested square edge in pixels. */
  size: number
  /** Whether this section is selected. */
  active: boolean
}

/** Owner share of the currently active settings-backed onboarding step. */
export interface SettingsOnboardingOwnerProps {
  /** Stable id of the step currently selected by the coordinator. */
  stepId: string
  /** User explicitly reopened this step outside first-run onboarding. */
  explicit?: boolean
  /** Complete or skip this step and transfer ownership to the next entry. */
  complete: () => void
  /** Open the settings panel directly on one registered section. */
  openSection: (id: string) => void
}

/** Settings navigation for the row above the launcher row. */
export interface SettingsNoticeOwnerProps {
  /** @param sectionId - section to open; absent uses the shell's default section. */
  openSettings: (sectionId?: string) => void
}

/** Sidebar launcher geometry and settings navigation. */
export interface SettingsLauncherOwnerProps {
  /** Whether the sidebar shows labels. */
  wide: boolean
  /** Whether the settings dialog covers the sidebar; a launcher may treat a false-to-true edge as one Settings entry. */
  settingsOpen: boolean
  /** Effective Settings key labels and accessible combination; omitted when unbound. */
  settingsShortcut?: { readonly keys: readonly string[]; readonly aria?: string | undefined }
  /** @param sectionId - section to open; absent uses the shell's default section. */
  openSettings: (sectionId?: string) => void
  /** @param id - registered onboarding editor to open explicitly. */
  openOnboarding: (id: string) => void
}
