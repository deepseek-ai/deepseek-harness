/**
 * Agent-preset management controller: the roster as a list, a copy dialog as
 * the only way a preset is created, and a read-only viewer over the shipped
 * compositions.
 *
 * The browser edits no composition text. A new preset is a host-side copy of
 * an existing one (`{ from, id, name? }` is all that crosses the wire), and
 * everything after creation happens in the preset's own files — which is why
 * the page's other job is getting the user TO those files: open the directory
 * where the host has a desktop, show its path where it does not.
 *
 * The host stays the single fact source. Every mutation writes through the
 * wire and the page re-reads the roster afterwards, because a copy changes
 * more than the row it targeted.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { beginRosterRead, writeDefaultPreset, writeModeSelectionEnabled } from './settings-store.ts'

/** Ids a preset directory may be named, mirroring the host's own rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** One preset row the page renders. */
export interface PresetRow {
  /** Preset id and directory name; the display name falls back to it. */
  id: string
  /** Display name the preset published, absent when it published none. */
  name?: string
  /** One sentence on what the preset is for. */
  description?: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
  /** Whether a session that names no preset gets this one. */
  isDefault: boolean
  /**
   * Why the preset cannot compose a session, absent when it can. A broken
   * row renders marked and unselectable — its directory still occupies the
   * id, so deleting it (or fixing the files) is the way out, and this page
   * is where both of those live.
   */
  broken?: string
}

/** The copy dialog: a new id and optional display name over a fixed source. */
export interface CopyDraft {
  /** The preset being copied. */
  from: string
  /** Display name of the source, for the dialog title. */
  fromTitle: string
  /** New preset id being typed; the directory name, so it is required. */
  id: string
  /** Display name being typed; empty falls back to the id. */
  name: string
  /** Whether the copy is in flight. */
  saving: boolean
  /** The last copy failure, cleared by the next edit. */
  error: string | null
}

/** The read-only composition viewer over one shipped preset. */
export interface PresetView {
  /** The preset whose composition is shown. */
  id: string
  /** Display name, for the dialog title. */
  title: string
  /** Composition text exactly as stored. */
  content: string
}

/** Page snapshot. */
export interface AgentPresetSectionState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  /** Whole-load failure text; a copy failure stays on the dialog. */
  error: string | null
  /** Whether the deployment configures a root new presets can be written to. */
  authorable: boolean
  /** Whether the host can open a preset directory on a native desktop. */
  hasDocument: boolean
  /** Whether new-session surfaces expose preset selection. */
  showPicker: boolean
  /** Whether a mode-selection policy write is in flight. */
  policySaving: boolean
  /** Every preset the deployment currently supplies. */
  rows: readonly PresetRow[]
  /** The open copy dialog, or null. */
  copy: CopyDraft | null
  /** The open read-only viewer, or null. */
  view: PresetView | null
  /** The preset awaiting delete confirmation. */
  pendingDelete: string | null
  /** Whether a delete is in flight. */
  deleting: boolean
  /**
   * Preset directories shown as text because the host has no desktop opener
   * — the answer `openDocument` gives instead of opening.
   */
  revealedPaths: Readonly<Record<string, string>>
}

const INITIAL: AgentPresetSectionState = {
  status: 'idle',
  error: null,
  authorable: false,
  hasDocument: false,
  showPicker: false,
  policySaving: false,
  rows: [],
  copy: null,
  view: null,
  pendingDelete: null,
  deleting: false,
  revealedPaths: {},
}

/**
 * Why this copy cannot be submitted yet, as a locale key, or undefined when
 * it can. Client-side only: the host re-checks the id and its answer is what
 * the dialog reports on failure.
 * @param draft - the open copy dialog.
 * @param rows - the roster, for the collision check.
 * @returns the blocking reason's locale key, or undefined when submittable.
 */
export function draftBlocker(
  draft: CopyDraft,
  rows: readonly PresetRow[],
): 'idRequired' | 'idInvalid' | 'idTaken' | undefined {
  if (draft.id === '') return 'idRequired'
  if (!PRESET_ID.test(draft.id)) return 'idInvalid'
  // A copy never overwrites: landing on a name already in use would replace
  // something the user did not open.
  if (rows.some(row => row.id === draft.id)) return 'idTaken'
  return undefined
}

/** Reads the roster and drives the copy dialog, viewer, and location reveals. */
export class AgentPresetSectionController {
  /** Page snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSectionState> = createSnapshotStore(INITIAL)

  /** The one roster load whose completion current callers await. */
  private loadFlight: Promise<void> | undefined
  private reloadRequested = false

  constructor(
    private readonly ctx: ClientContext,
    /**
     * Called after this page changes the roster DIRECTORY, so the other
     * surfaces reading the same roster re-read it. A settings field moving is
     * already announced by the host through the forwarded
     * `settings/document-updated`; a directory copied or deleted here is not,
     * and the new-session chip has no other way to learn a preset it should
     * offer now exists.
     */
    private readonly rosterChanged: () => void = () => {},
  ) {}

  private set(patch: Partial<AgentPresetSectionState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /** Read back and reflect the Host-effective default after a policy write. */
  private async confirmEffectiveDefault(showPicker: boolean): Promise<string | undefined> {
    await this.load()
    if (this.store.getSnapshot().status === 'error') await this.load()
    const state = this.store.getSnapshot()
    if (state.status !== 'ready' || state.showPicker !== showPicker) return undefined
    return state.rows.find(row => row.isDefault)?.id
  }

  /**
   * Show or hide new-session preset selection without changing the saved
   * default. The Host roster resolves that saved default while selection is
   * shown and the deployment default while it is hidden.
   * @param showPicker - whether the new-session picker should be exposed.
   * @param syncBlankSession - optional current-blank-task sync kept inside the saving state.
   * @returns once the Host state and optional blank-task sync settle.
   */
  async setPickerVisible(
    showPicker: boolean,
    syncBlankSession?: (id: string) => Promise<string | undefined>,
  ): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.status !== 'ready' || state.policySaving || state.showPicker === showPicker) return
    this.set({ policySaving: true, error: null })
    try {
      const failure = await writeModeSelectionEnabled(this.ctx, showPicker)
      if (failure !== undefined) {
        await this.load()
        this.set({ error: failure })
        return
      }
      const effectiveDefault = await this.confirmEffectiveDefault(showPicker)
      if (effectiveDefault === undefined) return
      const syncFailure = await syncBlankSession?.(effectiveDefault)
      if (syncFailure !== undefined) this.set({ error: syncFailure })
    } catch (error: unknown) {
      await this.load()
      this.set({ error: errorMessage(error) })
    } finally {
      this.set({ policySaving: false })
    }
  }

  private patchCopy(patch: Partial<CopyDraft>): void {
    const { copy } = this.store.getSnapshot()
    if (copy === null) return
    this.set({ copy: { ...copy, ...patch } })
  }

  /**
   * Load the roster. An empty roster means the deployment composes no
   * presets, which is a valid deployment rather than a failure — the section
   * reports `unavailable` and renders nothing.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    this.reloadRequested = true
    this.loadFlight ??= this.drainLoads()
    await this.loadFlight
  }

  /** Coalesce invalidations without losing changes received during a read. */
  private async drainLoads(): Promise<void> {
    try {
      do {
        await this.loadOnce()
      } while (this.reloadRequested)
    } finally {
      this.loadFlight = undefined
    }
  }

  /** Perform the section's one owned roster read. */
  private async loadOnce(): Promise<void> {
    this.reloadRequested = false
    // Whether a preset's directory can be opened is the Host's opener
    // capability rather than a roster property, so the page joins the two.
    // Both reads start together; one missing capability does not hide the roster.
    const opener = this.ctx.remote.settings.canOpenAgentPresetDirectory()
    const roster = await beginRosterRead(this.ctx, this.store)
    // A refused describe leaves the reveal-the-path path, which needs no opener.
    const described = await opener
    if (roster === undefined) return
    const { presets, authorable, modeSelectionEnabled: showPicker } = roster
    const hasDocument = described.ok && described.value
    if (presets.length === 0) {
      // Nothing to manage leaves nothing to keep a dialog open over.
      this.set({
        status: 'unavailable', rows: [], authorable, hasDocument, showPicker, copy: null, view: null,
      })
      return
    }
    // A reveal outlives a reload but not its preset: a path for a row the
    // roster no longer lists would be a claim about a directory that is gone.
    const revealed = this.store.getSnapshot().revealedPaths
    const kept = Object.fromEntries(
      Object.entries(revealed).filter(([id]) => presets.some(preset => preset.id === id)))
    this.set({
      status: 'ready',
      error: null,
      authorable,
      hasDocument,
      showPicker,
      rows: presets.map(preset => ({ ...preset })),
      revealedPaths: kept,
    })
  }

  /**
   * Open one shipped preset's composition in the read-only viewer.
   * @param id - the preset to view.
   * @returns once the composition loaded or the failure is on the page.
   */
  async view(id: string): Promise<void> {
    this.set({ error: null })
    const result = await this.ctx.remote.agentPresets.read(id)
    if (!result.ok) {
      this.set({ error: result.error.message })
      return
    }
    const { name, content } = result.value
    this.set({ view: { id, title: name ?? id, content } })
  }

  /** Close the read-only viewer. */
  closeView(): void {
    this.set({ view: null })
  }

  /**
   * Open the copy dialog over one preset.
   * @param from - the preset the copy will start from.
   */
  beginCopy(from: string): void {
    const row = this.store.getSnapshot().rows.find(candidate => candidate.id === from)
    this.set({
      error: null,
      copy: { from, fromTitle: row?.name ?? from, id: '', name: '', saving: false, error: null },
    })
  }

  /** Close the copy dialog, discarding whatever was typed. */
  cancelCopy(): void {
    this.set({ copy: null })
  }

  /**
   * Name the preset the copy creates.
   * @param id - the id typed into the dialog.
   */
  setCopyId(id: string): void {
    this.patchCopy({ id, error: null })
  }

  /**
   * Name the copy's display name.
   * @param name - the display name typed into the dialog.
   */
  setCopyName(name: string): void {
    this.patchCopy({ name, error: null })
  }

  /**
   * Submit the copy, re-read the roster, then take the user to the new
   * preset's files — the directory opens where the host has a desktop, and
   * its path appears on the new row where it does not.
   * @returns once the copy settled and the page reflects it.
   */
  async confirmCopy(): Promise<void> {
    const draft = this.store.getSnapshot().copy
    if (draft === null || draft.saving) return
    if (draftBlocker(draft, this.store.getSnapshot().rows) !== undefined) return
    this.patchCopy({ saving: true, error: null })
    const name = draft.name.trim()
    // Every declared parameter is passed even when optional: the Remote face
    // checks arity against the declaration and rejects a short call. An
    // empty display name goes as `undefined` — absent rather than empty, so
    // the host falls back to the id instead of labelling the row with ''.
    const result = await this.ctx.remote.agentPresets.copy(
      draft.from, draft.id, name === '' ? undefined : name)
    if (!result.ok) {
      this.patchCopy({ saving: false, error: result.error.message })
      return
    }
    this.set({ copy: null })
    await this.load()
    this.rosterChanged()
    // A preset is its files from here on (the dialog collected nothing
    // else), so landing in them is the completion, not a follow-up.
    await this.openLocation(draft.id)
  }

  /**
   * Open one preset's directory on the host desktop, or reveal its path on
   * the row where the deployment has no opener to hand it to.
   * @param id - the preset whose files the user wants.
   * @returns once the host answered and the page reflects it.
   */
  async openLocation(id: string): Promise<void> {
    const result = await this.ctx.remote.settings.openAgentPresetDirectory(id)
    if (!result.ok) {
      this.set({ error: result.error.message })
      return
    }
    if (result.value.opened) return
    const { path } = result.value
    this.set({ revealedPaths: { ...this.store.getSnapshot().revealedPaths, [id]: path } })
  }

  /**
   * Ask for confirmation before deleting one preset.
   * @param id - the preset to delete, or null to dismiss the confirmation.
   */
  confirmDelete(id: string | null): void {
    if (this.store.getSnapshot().deleting) return
    this.set({ pendingDelete: id })
  }

  /**
   * Delete the preset awaiting confirmation, then re-read the roster.
   *
   * A session already composed from it keeps running: its composition was
   * mounted at creation and nothing re-reads the file.
   * @returns once the delete settled and the page reflects it.
   */
  async remove(): Promise<void> {
    const { pendingDelete, deleting } = this.store.getSnapshot()
    if (pendingDelete === null || deleting) return
    this.set({ deleting: true, error: null })
    const result = await this.ctx.remote.agentPresets.deletePreset(pendingDelete)
    if (!result.ok) {
      this.set({ deleting: false, pendingDelete: null, error: result.error.message })
      return
    }
    this.set({ deleting: false, pendingDelete: null })
    await this.load()
    this.rosterChanged()
  }

  /**
   * Make one preset the default for sessions created later. Running sessions
   * keep the composition they began with, so this never disturbs work.
   * @param id - the preset to make default.
   * @param syncBlankSession - optional current-blank-task sync kept inside the policy lock.
   * @returns once the write and optional blank-task sync settle.
   */
  async makeDefault(
    id: string,
    syncBlankSession?: (id: string) => Promise<string | undefined>,
  ): Promise<void> {
    const state = this.store.getSnapshot()
    if (!state.showPicker || state.policySaving) return
    this.set({ policySaving: true, error: null })
    try {
      const failure = await writeDefaultPreset(this.ctx, id)
      if (failure !== undefined) {
        this.set({ error: failure })
        return
      }
      const effectiveDefault = await this.confirmEffectiveDefault(true)
      if (effectiveDefault === undefined) return
      const syncFailure = await syncBlankSession?.(effectiveDefault)
      if (syncFailure !== undefined) this.set({ error: syncFailure })
    } catch (error: unknown) {
      this.set({
        error: errorMessage(error),
      })
    } finally {
      this.set({ policySaving: false })
    }
  }
}
