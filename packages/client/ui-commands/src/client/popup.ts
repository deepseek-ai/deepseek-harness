/**
 * Headless popupSelect shell state: one controller per client
 * session, owned by CommandUiRuntime's per-session map and torn down by the
 * session scope disposer. The shell is a transient layer (never in the input
 * state machine): it loads options once, filters them locally against the
 * shell's own search text, and settles a selection through the context
 * captured at open time. Draft consumption and composer focus are injected
 * callbacks — the session wiring dispatches the consume-token event (the
 * Input side owns the span/bare-token CAS guard) and focuses the composer;
 * the controller never touches the input machine.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SelectOption } from './contract.ts'

/**
 * The command token segment snapshotted at shell-open time, replayed to the
 * injected {@link PopupSelectDeps.consume} callback after a successful
 * selection. The Input side guards it: a menu-path span consumes iff draftRev
 * is unchanged, an enter-path line iff the trimmed draft still equals the
 * bare token.
 */
export type TokenSegment =
  | { readonly via: 'menu'; readonly span: TokenSpan }
  | { readonly via: 'enter'; readonly token: string }

/**
 * Structural business spec the shell settles against — the popupSelect half
 * of CommandUiSpec, generic in the context value the opener captures (the
 * session wiring passes its session projection; the controller only carries
 * it from open() to the callbacks).
 */
export interface PopupSpec<TCtx> {
  /** Load the option rows once per open (retry after failure reuses the same signal). */
  options(context: TCtx, signal: AbortSignal): Promise<readonly SelectOption[]>
  /** Settle the picked option against the open-time context. */
  onSelect(option: SelectOption, context: TCtx): void | Promise<void>
}

/** Injected session-wiring callbacks of one controller (tests pass fakes). */
export interface PopupSelectDeps {
  /**
   * Consume the open-time token segment after a successful onSelect (the
   * wiring dispatches the consume-token event to the opening session).
   * @param segment - the open-time token segment snapshot.
   * @returns whether the token was consumed; false (CAS miss) is benign and
   * never retried.
   */
  consume(segment: TokenSegment): boolean
  /** Return focus to the session composer (successful settle and Escape close paths). */
  focusComposer(): void
}

/** Popup shell state (the shell component renders from here; closed = render null). */
export interface PopupState {
  readonly open: boolean
  /** Command name the shell is open for (null while closed). */
  readonly command: string | null
  /** Options-load lifecycle; 'failed' keeps the shell open for retry(). */
  readonly status: 'pending' | 'ready' | 'failed'
  /** Options as loaded — never re-fetched per keystroke; views render {@link filterOptions} over them. */
  readonly options: readonly SelectOption[]
  /** Local filter text over the loaded options. */
  readonly search: string
  /**
   * Highlight index into the filtered row list: 0 until options land; afterwards
   * the row the loaded list marks as the current value
   * ({@link SelectOption.active}), else 0. A search rebases it to the top of the
   * filtered rows.
   */
  readonly active: number
  /** A select() settlement is in flight: further select/search/highlight no-op until it settles. */
  readonly submitting: boolean
  /** Option waiting for explicit risk acknowledgement; null during normal selection. */
  readonly confirming: SelectOption | null
  /** Caller-controlled checkbox state for the pending confirmation. */
  readonly acknowledged: boolean
  /** Surfaced settlement failure (options load or onSelect); null when none. */
  readonly error: string | null
}

const CLOSED: PopupState = {
  open: false, command: null, status: 'pending', options: [], search: '', active: 0,
  submitting: false, confirming: null, acknowledged: false, error: null,
}

/**
 * Filter option rows against the shell's local search text (case-insensitive
 * substring over label and detail; blank search keeps every row).
 * @param options - the loaded rows.
 * @param search - the shell's search text.
 * @returns the rows the shell shows and highlights over.
 */
export function filterOptions(options: readonly SelectOption[], search: string): readonly SelectOption[] {
  const query = search.trim().toLowerCase()
  if (query === '') return options
  return options.filter(o => o.label.toLowerCase().includes(query) || (o.detail?.toLowerCase().includes(query) ?? false))
}

/**
 * Highlight index for a freshly loaded row list: the row marked as the current
 * value when the live search still shows it, else the top row. Opening parks
 * the highlight on the value the session already uses, so an accept gesture
 * made without looking confirms that value instead of the topmost row.
 * @param options - the loaded rows.
 * @param search - the shell's live filter text (non-empty after a retry).
 * @returns index into the filtered rows.
 */
function currentIndex(options: readonly SelectOption[], search: string): number {
  const at = filterOptions(options, search).findIndex(option => option.active === true)
  return at === -1 ? 0 : at
}

/** One open shell's bindings (spec + open-time context + segment snapshot + options-fetch abort). */
interface OpenBinding<TCtx> {
  readonly command: string
  readonly spec: PopupSpec<TCtx>
  readonly context: TCtx
  readonly segment: TokenSegment
  readonly abort: AbortController
}

/** The shell's error-strip line for a settlement failure. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Headless controller of one session's popupSelect shell. Late settlements
 * lose their write rights through binding identity: dismiss/dispose/reopen
 * swap the binding, so a settling options fetch or onSelect that no longer
 * matches writes nothing and consumes nothing.
 */
export class PopupSelectController<TCtx = unknown> {
  /** Shell state store (the overlay component subscribes here). */
  readonly state: SnapshotStore<PopupState> = createSnapshotStore<PopupState>(CLOSED)
  private binding: OpenBinding<TCtx> | null = null

  /**
   * @param deps - session-wiring callbacks (token consumption + composer focus).
   */
  constructor(private readonly deps: PopupSelectDeps) {}

  /**
   * Open the shell for one command: publish pending state and fetch options
   * once through the business spec. A reopen supersedes the previous shell
   * (its options fetch is aborted, its late settlements are dropped).
   * @param command - command name the shell serves.
   * @param spec - the registered popupSelect spec.
   * @param context - open-time context snapshot, handed verbatim to options/onSelect.
   * @param segment - open-time token segment snapshot for post-select consumption.
   */
  open(command: string, spec: PopupSpec<TCtx>, context: TCtx, segment: TokenSegment): void {
    this.binding?.abort.abort()
    const binding: OpenBinding<TCtx> = { command, spec, context, segment, abort: new AbortController() }
    this.binding = binding
    this.state.set({ ...CLOSED, open: true, command })
    this.load(binding)
  }

  /** Run the one options fetch of a binding; settlement rights die with the binding. */
  private load(binding: OpenBinding<TCtx>): void {
    binding.spec.options(binding.context, binding.abort.signal).then(
      (options) => {
        if (this.binding !== binding) return
        const current = this.state.getSnapshot()
        this.state.set({ ...current, status: 'ready', options, active: currentIndex(options, current.search), error: null })
      },
      (error: unknown) => {
        if (this.binding !== binding) return
        console.error(`[ui-commands] popupSelect options failed for /${binding.command}:`, error)
        this.state.set({ ...this.state.getSnapshot(), status: 'failed', options: [], active: 0, error: errorText(error) })
      },
    )
  }

  /** Re-run a failed options fetch (search survives; no-op unless status is 'failed'). */
  retry(): void {
    const binding = this.binding
    const s = this.state.getSnapshot()
    if (binding === null || !s.open || s.status !== 'failed') return
    this.state.set({ ...s, status: 'pending', error: null })
    this.load(binding)
  }

  /**
   * Replace the local search text (pure local filter — the provider is never
   * re-queried) and rebase the highlight to the top of the new filtered list:
   * typing searches for something other than the current value.
   * @param search - the shell search input's text.
   */
  setSearch(search: string): void {
    const s = this.state.getSnapshot()
    if (!s.open || s.submitting || s.confirming !== null || search === s.search) return
    this.state.set({ ...s, search, active: 0 })
  }

  /**
   * Move the highlight across the filtered rows (wraps around; no-op unless
   * options are ready and no selection is in flight).
   * @param dir - +1 down, -1 up.
   */
  move(dir: 1 | -1): void {
    const s = this.state.getSnapshot()
    if (!s.open || s.status !== 'ready' || s.submitting || s.confirming !== null) return
    const rows = filterOptions(s.options, s.search)
    if (rows.length === 0) return
    const active = (s.active + dir + rows.length) % rows.length
    this.state.set({ ...s, active })
  }

  /**
   * Set the highlight directly (pointer hover; no-op unless ready, idle, and
   * in filtered range).
   * @param index - filtered-row index.
   */
  highlight(index: number): void {
    const s = this.state.getSnapshot()
    if (!s.open || s.status !== 'ready' || s.submitting || s.confirming !== null) return
    if (index < 0 || index >= filterOptions(s.options, s.search).length || index === s.active) return
    this.state.set({ ...s, active: index })
  }

  /**
   * Select one filtered row: single-flight — the first call enters
   * `submitting` and later calls no-op until it settles. Success consumes the
   * open-time token segment (a false CAS answer is benign), closes, and
   * returns focus to the composer. Failure keeps the shell open with search,
   * highlight, and token intact, surfaces the error, and re-arms select as
   * the retry.
   * @param index - filtered-row index (callers pass the highlight or the clicked row).
   * @returns settled when the attempt has closed the shell or surfaced its failure.
   */
  async select(index: number): Promise<void> {
    const binding = this.binding
    const s = this.state.getSnapshot()
    if (binding === null || !s.open || s.status !== 'ready' || s.submitting || s.confirming !== null) return
    const option = filterOptions(s.options, s.search)[index]
    if (option === undefined) return
    if (option.confirmation !== undefined) {
      this.state.set({ ...s, confirming: option, acknowledged: false, error: null })
      return
    }
    await this.settle(binding, option)
  }

  /**
   * Update the explicit checkbox for the currently pending risk gate.
   * @param acknowledged - whether the user has acknowledged the displayed risk.
   */
  acknowledge(acknowledged: boolean): void {
    const s = this.state.getSnapshot()
    if (!s.open || s.submitting || s.confirming === null || s.acknowledged === acknowledged) return
    this.state.set({ ...s, acknowledged })
  }

  /** Cancel only the risk gate and return to the still-open option picker. */
  cancelConfirmation(): void {
    const s = this.state.getSnapshot()
    if (!s.open || s.submitting || s.confirming === null) return
    this.state.set({ ...s, confirming: null, acknowledged: false })
  }

  /** Settle the gated option only after the checkbox is acknowledged. */
  async confirm(): Promise<void> {
    const binding = this.binding
    const s = this.state.getSnapshot()
    if (binding === null || !s.open || s.submitting || s.confirming === null || !s.acknowledged) return
    await this.settle(binding, s.confirming)
  }

  /** Run the business settlement for an already admitted option. */
  private async settle(binding: OpenBinding<TCtx>, option: SelectOption): Promise<void> {
    const s = this.state.getSnapshot()
    if (this.binding !== binding || !s.open || s.submitting) return
    this.state.set({ ...s, submitting: true, confirming: null, acknowledged: false, error: null })
    try {
      await binding.spec.onSelect(option, binding.context)
    } catch (error) {
      console.error(`[ui-commands] popupSelect onSelect failed for /${binding.command}:`, error)
      if (this.binding !== binding) return // dismissed/reopened/disposed while onSelect flew
      this.state.set({ ...this.state.getSnapshot(), submitting: false, error: errorText(error) })
      return
    }
    if (this.binding !== binding) return // late success: no state write, no consumption
    this.deps.consume(binding.segment)
    this.binding = null
    this.state.set(CLOSED)
    this.deps.focusComposer()
  }

  /**
   * Close the shell; aborts a flying options fetch and revokes settlement
   * rights. An outside pointer interaction dismisses plainly (the click's own
   * target takes focus); Escape passes focusComposer to return focus explicitly.
   * @param opts - focusComposer: also restore composer focus (Escape path).
   */
  dismiss(opts?: { readonly focusComposer?: boolean }): void {
    if (this.binding === null) return
    this.binding.abort.abort()
    this.binding = null
    this.state.set(CLOSED)
    if (opts?.focusComposer === true) this.deps.focusComposer()
  }

  /** Scope-teardown disposer: abort in-flight work and clear state (no focus side effect). */
  dispose(): void {
    this.binding?.abort.abort()
    this.binding = null
    this.state.set(CLOSED)
  }
}
