/** Command contributions and immutable catalog values. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { BindingIssue, NormalizedBinding, ShortcutConfigSnapshot, ShortcutEdit, ShortcutRevision, ShortcutSaveResult, ShortcutBinding, ShortcutCommandId, ShortcutPlatform, ShortcutProfile, ShortcutRuntime } from '../protocol.ts'

/** Local input owner resolved before an application command. */
export type ShortcutRegion = 'page' | 'editable' | 'terminal'
/** Synchronous DOM context; owners capture business targets in resolve(). */
export interface ShortcutContext {
  readonly source?: 'keyboard' | 'menu' | 'iframe' | 'webview'
  readonly region: ShortcutRegion
  readonly modal: string | null
  /** Original input element, or null when no document target is available. */
  readonly target: Element | null
}
/** A resolved action captures its target; failures remain the owner's responsibility. */
export type ShortcutResolution = { status: 'handled'; run(): void }
  | { status: 'blocked'; reason: string }
  | { status: 'pass' }
/** One command's labels, defaults, input ownership, and target resolver. */
export interface ShortcutCommand {
  readonly id: ShortcutCommandId
  readonly label: () => string
  readonly aliases: readonly string[]
  readonly defaults: Readonly<Partial<Record<ShortcutProfile, ShortcutBinding>>>
  readonly regions: readonly ShortcutRegion[]
  /**
   * Allowed modal identifiers for Web/Linux keyboard input and explicit menu actions;
   * Windows/macOS Desktop keyboard bindings take priority.
   */
  readonly modals: readonly string[]
  resolve(context: ShortcutContext): ShortcutResolution
}
/** JSON-compatible catalog row, shared by reference, tooltips, and controls. */
export interface ShortcutCatalogEntry {
  readonly id: ShortcutCommandId
  readonly label: string
  readonly aliases: readonly string[]
  readonly keys: readonly string[]
  readonly aria: string | undefined
  readonly binding: NormalizedBinding | null
  readonly modified: boolean
  readonly conflicts: readonly ShortcutCommandId[]
  readonly issue: BindingIssue | null
}
/** Keyboard adapter input, with composition and local consumption already resolved. */
export interface ShortcutGesture {
  readonly code: string
  /** Second physical key currently held with code; matching ignores pair order. */
  readonly secondCode?: string
  readonly control: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly repeat: boolean
  readonly composing: boolean
  readonly defaultPrevented: boolean
}
/** Local fixed input delivered after controls, or a sequence-invalidating interaction. */
export type ShortcutFixedInput = {
  readonly type: 'keydown'
  readonly gesture: ShortcutGesture
  readonly context: ShortcutContext
  consume(): void
} | { readonly type: 'reset' }
/** Read-only input action contributed while its owning feature is mounted. */
export interface ShortcutFixedCommand {
  readonly id: ShortcutCommandId
  readonly label: () => string
  readonly keys: readonly string[]
  /** One or more physical combinations reserved by this action, including individual steps of a sequence. */
  readonly bindings: readonly [ShortcutBinding, ...ShortcutBinding[]]
  readonly group: 'application' | 'input' | 'menus' | 'approval'
}
/** Localized fixed-action row; its key sequence is not an editable binding. */
export interface ShortcutFixedCatalogEntry {
  readonly id: ShortcutCommandId
  readonly label: string
  readonly keys: readonly string[]
  readonly bindings: readonly NormalizedBinding[]
  readonly group: ShortcutFixedCommand['group']
}
/** Feature-facing keyboard registry. */
export interface Shortcuts {
  readonly runtime: ShortcutRuntime
  readonly platform: ShortcutPlatform
  readonly catalog: ObservableSnapshot<readonly ShortcutCatalogEntry[]>
  readonly config: ObservableSnapshot<ShortcutConfigSnapshot>
  readonly fixedCatalog: ObservableSnapshot<readonly ShortcutFixedCatalogEntry[]>
  readonly stopSequenceMs: number
  /**
   * Contribute one fixed action and reserve its keys against editable bindings.
   * @param command - owner-localized name, group, readable keys, and reserved physical combinations.
   * @returns idempotent disposer removing the fixed row.
   */
  registerFixed(command: ShortcutFixedCommand): () => void
  /**
   * Observe locally arbitrated input and interaction resets for fixed sequences.
   * @param listener - owner handler; composing or consumed input must not trigger actions.
   * @returns disposer releasing the handler.
   */
  observeFixedInput(listener: (input: ShortcutFixedInput) => void): () => void
  /**
   * Describe a candidate using the device's physical-key and reservation rules; invalid codes throw.
   * @param binding - candidate combination, or null for an unbound command.
   * @returns canonical binding, visible keys, rejection reason, and overlapping editable/fixed command IDs.
   */
  describeBinding(binding: ShortcutBinding | null): {
    binding: NormalizedBinding | null
    keys: readonly string[]
    issue: BindingIssue | null
    conflicts: readonly ShortcutCommandId[]
  }
  /**
   * Save a reviewed edit; failures preserve both accepted preferences and the caller's draft.
   * @param edit - set, clear, reset, or reset-all operation.
   * @param revision - accepted revision reviewed by the user.
   * @returns persistence outcome and current accepted configuration.
   * @throws when publishing the accepted command catalog fails.
   */
  edit(edit: ShortcutEdit, revision: ShortcutRevision): Promise<ShortcutSaveResult>
  /**
   * Suppress native menu accelerators while the recording layer owns keyboard input; reject if Desktop cannot acknowledge it.
   * @param active - whether the recording layer is mounted.
   * @returns completion of the native interception update.
   */
  recording(active: boolean): Promise<void>
  /**
   * Request closure of the Desktop window using the currently accepted shortcut revision.
   * @returns completion of the native request; rejects outside Desktop or when the bridge request fails.
   */
  closeWindow(): Promise<void>
  /**
   * Register a command; duplicate ids and overlapping default bindings throw.
   * @param command - feature-owned labels, defaults, and target resolver.
   * @returns disposer removing the binding and catalog entry.
   */
  register(command: ShortcutCommand): () => void
}
