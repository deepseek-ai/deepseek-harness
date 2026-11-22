/** Session panel slot declarations and composed component props. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { NS } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Sections of the Session panel. `id` addresses the section, `order` sorts
     * the sections ascending until the reader drags them into another order,
     * and the required `label` is the section title, which the panel draws.
     * The built-in Environment section always shows first. A section with
     * nothing to show renders nothing, and the panel hides its title with it.
     */
    'conversation.session.panel.section': {
      kind: 'list'
      scope: 'session'
      owner: SessionPanelSectionOwnerProps
    }
    /**
     * Trailing content of one section title, such as a count, keyed by the
     * section's `id`. In every section but Environment the drag handle shows
     * in its place while the title row is hovered, so it holds content to
     * read, not a control to press.
     */
    'conversation.session.panel.section.actions': { kind: 'keyed'; scope: 'session' }
    /**
     * Marks over the panel toggle, such as an attention dot. Each occupant is
     * one element: the toggle sizes it to a 6px dot at the glyph's corner, and
     * the occupant sets its `background` and includes text that names it for
     * assistive technology, which becomes part of the toggle's name. Occupants
     * overlap, and a higher `order` paints above a lower one. An occupant that
     * only repeats what the panel shows renders nothing while `panelShown`.
     */
    'conversation.session.panel.indicator': {
      kind: 'list'
      scope: 'session'
      inline: true
      owner: SessionPanelIndicatorOwnerProps
    }
    /** Rows of the built-in Environment section in ascending `order`; they receive the section's owner values. */
    'conversation.session.panel.environment.row': { kind: 'list'; scope: 'session'; owner: SessionPanelSectionOwnerProps }
  }
  interface SlotFactoryMap {
    /**
     * The fold control of a panel list. A list shows at most five rows of a
     * group and then this control as its last row, which shows the rest or
     * folds them again; a list folds only when that hides two rows or more,
     * since the control takes a row itself. The list keeps the fold state and
     * decides which rows show.
     */
    'conversation.session.panel.fold': { scope: 'root'; props: PanelFoldProps }
    /**
     * The details of one panel row, for the content of the row's HoverCard: the
     * row's full name, secondary lines such as its owner, its state, and its
     * measures. A row whose single line clips or leaves these out shows them
     * here.
     */
    'conversation.session.panel.details': { scope: 'root'; props: PanelDetailsProps }
  }
}

/** What a panel row's hover card says about the row. */
export interface PanelDetailsProps {
  /**
   * The full name of what the row shows; it wraps instead of clipping. Omit it
   * when the name can run long, such as a command, and the row's own view
   * shows it in full.
   */
  readonly title?: string | undefined
  /** Lines in secondary type under the title, such as the owner; each stops after six lines. */
  readonly lines?: readonly string[] | undefined
  /** The state, after its dot. */
  readonly status?: { readonly state: StateDotState; readonly label: string } | undefined
  /** Measures on one line, at most one of each kind. */
  readonly facts?: readonly PanelDetailsFact[] | undefined
}

/** One measure in a panel row's hover card. */
export interface PanelDetailsFact {
  /** What the measure counts, which selects its icon: a database for `tokens`, a clock for `duration`. */
  readonly kind: 'tokens' | 'duration'
  /** The measure as the card shows it, such as "3.3M tok" or "6m 56s". */
  readonly label: string
}

/** Props of the fold control that ends a folded panel list. */
export interface PanelFoldProps {
  /** Whether the list shows every row; the control then folds it again. */
  readonly expanded: boolean
  /** Visible text for the current state, such as "Show 14 more" or "Show less". */
  readonly label: string
  /** Accessible name for the current state; it starts with `label` and names what the list holds. */
  readonly name: string
  /** Show every row, or fold the list again. */
  readonly onToggle: () => void
}

/** How the panel currently shows. */
export type SessionPanelPresentation =
  /** Beside the transcript in the Chat View's end gutter, which the transcript moves aside to leave where it is narrower. */
  | 'docked'
  /** Over the transcript, opened from the toggle while the panel has no room to dock. */
  | 'overlay'

/** Values every section receives from the panel. */
export interface SessionPanelSectionOwnerProps {
  /** Current presentation; sections may lower their density in the overlay. */
  readonly presentation: SessionPanelPresentation
  /** Close the overlay, for example after a row opened another surface; no effect while docked. */
  readonly dismissOverlay: () => void
}

/** Values every toggle indicator receives from the toggle. */
export interface SessionPanelIndicatorOwnerProps {
  /** Whether the panel shows, docked or as an overlay. */
  readonly panelShown: boolean
}

/** One section the panel draws, projected from the section list's registrations. */
export interface SessionPanelSectionEntry {
  /** Registration id. */
  readonly id: string
  /** Localized title. */
  readonly label: string
}

/** Panel visibility shared by the toggle and the panel. */
export interface SessionPanelVisibility {
  /** Whether the panel docks while it has room, in the gutter or where the transcript moves aside for it; persisted across reloads. */
  readonly pinned: boolean
  /** Session whose overlay is open, or null. */
  readonly overlay: SessionId | null
}

/**
 * Whether each Session whose Chat View holds a panel has room to dock it:
 * true when, in at least one of its Chat Views, the end gutter holds the
 * docked panel or the transcript can move aside to leave that gutter. A
 * Session without an entry shows no Chat View.
 */
export type SessionPanelDockable = ReadonlyMap<SessionId, boolean>

/**
 * Whether each mounted panel's Chat View has room for the docked panel, by
 * the id the panel gave its dock probe.
 */
export type SessionPanelProbes = ReadonlyMap<string, boolean>

/** Business face of the header toggle. */
export interface SessionPanelToggleInjected {
  /** Shared visibility and each Session's room to dock; the renderer binds them as `useVisibility` and `useDockable`. */
  readonly hooks: {
    readonly visibility: ObservableSnapshot<SessionPanelVisibility>
    readonly dockable: ObservableSnapshot<SessionPanelDockable>
  }
  /**
   * Show or hide the panel. With room to dock this flips the docking
   * preference and closes any overlay; otherwise it opens or closes the
   * Session's overlay. No effect while no Chat View shows the Session.
   * @param sessionId - Session whose header holds the toggle.
   */
  readonly toggle: (sessionId: SessionId) => void
}

/** Business face of the panel. */
export interface SessionPanelInjected {
  /**
   * Shared visibility, the projected section roster, and each dock probe's
   * room; the renderer binds them as `useVisibility`, `useSections`, and `useProbes`.
   */
  readonly hooks: {
    readonly visibility: ObservableSnapshot<SessionPanelVisibility>
    readonly sections: ObservableSnapshot<readonly SessionPanelSectionEntry[]>
    readonly probes: ObservableSnapshot<SessionPanelProbes>
  }
  /**
   * Create the ref of one mounted panel's dock probe, the element whose
   * stylesheet width says whether the Chat View has room for the docked
   * panel. The plugin observes the element while it is attached and records
   * the probe's room under `probe`, and the Session's for the toggle.
   * @param sessionId - Session the panel's Chat View shows.
   * @param probe - identity of the panel within the page.
   * @returns the ref callback for the probe element; detaching withdraws the probe.
   */
  readonly createProbeRef: (sessionId: SessionId, probe: string) => (element: HTMLElement | null) => void
  /**
   * Close the Session's overlay.
   * @param sessionId - Session whose overlay closes; another Session's overlay stays.
   */
  readonly closeOverlay: (sessionId: SessionId) => void
  /**
   * Move a section beside another in every Session's panel; the order
   * persists across reloads. Environment does not move, and a section always
   * lands after it.
   * @param id - section to move.
   * @param target - section it lands beside.
   * @param placement - the side of the target it lands on.
   */
  readonly moveSection: (id: string, target: string, placement: 'before' | 'after') => void
}

/** Business face of the project row. */
export interface ProjectRowInjected {
  /** Host facts from the connection's ready frame; the renderer binds them as `useHost`. */
  readonly hooks: { readonly host: ObservableSnapshot<RemoteHostFacts> }
}

/** Full props of the header toggle. */
export type SessionPanelToggleProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsRenderSlots<'conversation.session.panel.indicator'>
  & InjectFace<SessionPanelToggleInjected>
  & PropsLocale<typeof NS>

/** Full props of the panel. */
export type SessionPanelProps =
  PropsRuntime<'conversation.chat.aside'>
  & PropsRenderSlots<'conversation.session.panel.section' | 'conversation.session.panel.section.actions'>
  & InjectFace<SessionPanelInjected>
  & PropsLocale<typeof NS>

/** Full props of the built-in Environment section. */
export type EnvironmentSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & PropsRenderSlots<'conversation.session.panel.environment.row'>

/** Full props of the project row. */
export type ProjectRowProps =
  PropsRuntime<'conversation.session.panel.environment.row'>
  & PropsRenderFactories
  & InjectFace<ProjectRowInjected>
  & PropsLocale<typeof NS>
