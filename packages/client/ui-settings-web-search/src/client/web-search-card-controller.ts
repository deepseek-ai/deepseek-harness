/**
 * The web search and fetch page's staged form over three settings namespaces:
 * `web`, whose `searchProvider` and `fetchProvider` the two provider menus
 * write, `web-deepseek-api` for the DeepSeek Search and Fetch APIs, and
 * `web-search-deepseek` for legacy Messages search.
 *
 * A selection equal to the deployment's composed value clears the override
 * instead of storing a copy of it, and while the deployment composes no
 * provider for a capability its menu also offers automatic selection, which
 * clears the override. The menus offer the providers the Host reports through
 * `web/listProviders`, the official ones first in a fixed order and the rest
 * in registration order, plus a selected id the Host no longer registers. A
 * failed read is reported on the page with a retry.
 *
 * The DeepSeek Search and Fetch APIs take no credential settings here: they
 * follow the DeepSeek credential of the conversation, and their own endpoint
 * fields are YAML-only. Legacy Messages search keeps its key control.
 *
 * The legacy key's literal never rides a response, so the page learns only
 * whether one is configured and writes it through the credentials domain,
 * addressed by the reference `web-search-deepseek.apiKeyEnv` names. A key
 * draft belongs to the reference its control addressed when it was typed: it
 * is dropped when that reference changes or the page stops showing the
 * control, and a save writes it under that reference. The key is still staged
 * with the rest of the form, so one save covers everything the page shows.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { WebProviderInfo, WebProviderList as ProviderList } from '@deepseek-ai/dsh-web/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormShell, type SettingsFormScope,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespaces this page edits. Spelled here rather than imported: a client
 * package must not depend on a Host package.
 */
export const WEB_SEARCH_NS = 'web-search-deepseek'
/** Namespace of the DeepSeek Search and Fetch API providers. */
export const WEB_API_NS = 'web-deepseek-api'
/** Namespace of the web service's provider selection. */
export const WEB_NS = 'web'

/** Provider ids of the official providers whose settings this page edits. */
export const PROVIDER_IDS = {
  apiSearch: 'deepseek-search-api',
  legacySearch: 'deepseek-official',
  localFetch: 'http',
  apiFetch: 'deepseek-fetch-api',
} as const

/**
 * The official providers each menu lists first, in this order, while the Host
 * registers them; the Host's own list stays in registration order.
 */
const MENU_ORDER = {
  search: [PROVIDER_IDS.apiSearch, PROVIDER_IDS.legacySearch],
  fetch: [PROVIDER_IDS.localFetch, PROVIDER_IDS.apiFetch],
} as const satisfies Record<keyof ProviderList, readonly string[]>

/** Credential reference legacy Messages search resolves when its section names none. */
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'legacyApiKey'

/** Settings-section fields the face edits as text. */
export type WebSectionField = 'count' | 'messagesBaseURL' | 'maxUses'

/** The legacy key control. */
export type WebApiKeyField = 'legacyApiKey'

/** Controls the face edits as text: the key controls and the settings-section fields. */
export type WebSearchCardField = WebApiKeyField | WebSectionField

/** The web service's provider selection. */
export interface WebProviderSelection {
  /** Search provider id. */
  searchProvider?: string
  /** Fetch provider id. */
  fetchProvider?: string
}

/** The Messages search fields this page edits. */
export interface WebLegacySettings {
  /** Credential reference naming the environment key. */
  apiKeyEnv?: string
  /** Messages endpoint; blank inherits the provider default. */
  baseURL?: string
  /** Maximum Messages server-tool uses. */
  maxUses?: number
}

/** The Search and Fetch API fields this page edits. */
export interface WebApiSettings {
  /** Search API results per search. */
  count?: number
}

/** One entry of a provider menu. */
export interface WebProviderOption {
  /** Provider id, written into the selection. */
  id: string
  /** Title the provider registered with, if any. */
  title?: string
  /** Description the provider registered with, if any; the page shows it under the menu while the provider is selected. */
  description?: WebProviderInfo['description']
  /** True for a selected id the Host does not currently register. */
  missing: boolean
}

/** What the Search section shows for its selected provider. */
export type WebSearchKind = 'deepseek' | 'legacy' | 'plugin' | 'none'
/** What the Fetch section shows for its selected provider. */
export type WebFetchKind = 'local' | 'deepseek' | 'plugin' | 'none'

/** The legacy key control. */
export interface WebApiKeyState extends SettingsFieldState {
  /** Whether the Host reports a credential configured for the referenced key. */
  configured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  writable: boolean
  /** The credential reference the control writes: `web-search-deepseek.apiKeyEnv`, or its default. */
  ref: string
}

/** One provider section: its menu and the controls its selection shows. */
export interface WebProviderSectionState<K extends string> {
  /** Id of the selected provider, or the empty string when the selection names none. */
  selected: string
  /** Menu entries: the registered providers, plus a selected id that is not registered. */
  options: readonly WebProviderOption[]
  /** Which provider-specific controls the section shows. */
  kind: K
  /** Whether the menu offers automatic selection, because the deployment composes no provider for this capability. */
  auto: boolean
}

/** What the web search and fetch page renders. */
export interface WebSearchCardState extends SettingsFormShell {
  /** Invalid edits or failed saves that changing providers must keep visible. */
  selectionBlocked: boolean
  /**
   * Whether the latest provider list read failed. The menus keep the last list
   * read, or before any list arrives only the selected ids, so they may be
   * incomplete.
   */
  providersFailed: boolean
  /** The Search section. */
  search: WebProviderSectionState<WebSearchKind>
  /** The Fetch section. */
  fetch: WebProviderSectionState<WebFetchKind>
  /** Search API results per search, shown in the Search section while it selects the DeepSeek Search API. */
  count: SettingsFieldState
  /** Legacy Messages endpoint. */
  messagesBaseURL: SettingsFieldState
  /** Legacy server-side search limit. */
  maxUses: SettingsFieldState
  /** Legacy key control, present only while the legacy provider is selected. */
  legacyKey: WebApiKeyState | undefined
}

/** The registration-side face the page's slot entry injects. */
export interface WebSearchCardFace extends Pick<SettingsFormActions, 'save' | 'discard'> {
  hooks: {
    /** Page snapshot bound by the renderer as useWebSearchCard. */
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
  /** Stage draft text for one control. */
  edit: (field: WebSearchCardField, text: string) => void
  /** Stage a clear for one section field. */
  resetField: (field: WebSectionField) => void
  /** Stage one provider selection; the empty id stages automatic selection. */
  selectProvider: (field: keyof WebProviderSelection, id: string) => void
  /** Re-read the registered providers after a failed read. */
  retryProviders: () => void
  /** Resolve a provider description to the active language. */
  resolveText: (text: NonNullable<WebProviderOption['description']>) => string
}

/** Settings scopes for the namespaces the page edits. */
export interface WebSearchCardScopes {
  /** The web service's provider selection. */
  web: SettingsFormScope<WebProviderSelection>
  /** Search and Fetch API settings. */
  api: SettingsFormScope<WebApiSettings>
  /** Legacy Messages search settings. */
  legacy: SettingsFormScope<WebLegacySettings>
}

/** What the credentials domain last reported for the legacy key control. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials/set` can affect it; false disables the control. */
  writable: boolean
}

/** What `credentials/describe` answers, by reference. */
type CredentialViews = Readonly<Record<string, { configured: boolean; writable: boolean } | undefined>>

/** Bridges the settings scopes, the provider lists, and the credentials domain onto the page. */
export class WebSearchCardController {
  private readonly selection: SettingsFormModel<WebProviderSelection>
  private readonly api: SettingsFormModel<WebApiSettings>
  private readonly legacy: SettingsFormModel<WebLegacySettings>
  private readonly store: SnapshotStore<WebSearchCardState>
  private readonly unsubscribe: (() => void)[]
  private credential: CredentialState
  private credentialReadQueued = false
  private credentialReadSequence = 0
  /** Reference the key draft was typed for; read only while that draft is non-empty. */
  private draftRef: string
  /** The draft reference the running or last selection save writes under. */
  private savingRef: string
  private droppingDraft = false
  private providers: ProviderList | undefined
  private providersFailed = false
  private providerReadSequence = 0
  private selectionServed = false
  private disposed = false

  /**
   * @param scopes - the bound settings scopes for the page's namespaces.
   * @param ctx - the page plugin's context, whose `remote.credentials` namespace
   * answers for the credential the legacy key control references, and whose
   * `remote.web` namespace lists the registered providers.
   */
  constructor(
    private readonly scopes: WebSearchCardScopes,
    private readonly ctx: ClientContext,
  ) {
    this.credential = { ref: this.ref(), configured: false, writable: true }
    this.draftRef = this.ref()
    this.savingRef = this.draftRef
    this.selection = new SettingsFormModel(scopes.web, [
      settingsTextField('searchProvider'), settingsTextField('fetchProvider'),
    ], [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }])
    this.api = new SettingsFormModel(scopes.api, [
      {
        ...settingsNumberField('count'),
        parse: (text) => {
          if (text.trim() === '') return { kind: 'clear' }
          const value = Number(text)
          return Number.isInteger(value) && value >= 1 && value <= 50 ? { kind: 'set', value } : undefined
        },
      },
    ])
    this.legacy = new SettingsFormModel(scopes.legacy, [
      settingsTextField('baseURL'),
      { ...settingsNumberField('maxUses'), parse: (text) => {
        if (text.trim() === '') return { kind: 'clear' }
        const value = Number(text)
        return Number.isInteger(value) && value >= 1 ? { kind: 'set', value } : undefined
      } },
    ])
    this.selectionServed = this.selection.shell().available
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = [
      ...[this.selection, this.api, this.legacy].map(form => form.bind(() => form.shell()).subscribe(() => { this.publish() })),
      ...[scopes.web, scopes.api, scopes.legacy].map(scope => scope.subscribe(() => { this.queueCredentialRead() })),
      scopes.web.subscribe(() => {
        // The provider list comes from the web service; a Host that starts
        // serving it registers providers this page has not read.
        const served = this.selection.shell().available
        if (served && !this.selectionServed) this.refreshProviders()
        this.selectionServed = served
      }),
    ]
    void this.readCredential()
    this.refreshProviders()
  }

  /**
   * Republish after a form or scope change. A staged selection can hide the
   * key control without any scope publishing; a scope change can rename the
   * reference itself.
   */
  private publish(): void {
    // Dropping a draft stages an edit, which republishes; publish once after it.
    if (this.droppingDraft) return
    this.dropStaleKeyDraft()
    const ref = this.ref()
    if (ref !== this.credential.ref) {
      this.resetCredentialReference(ref)
      this.queueCredentialRead()
    }
    this.store.set(this.projection())
  }

  /** The provider id a selection field stages. */
  private selected(field: keyof WebProviderSelection): string {
    return this.selection.field(field).text
  }

  /**
   * Menu entries for one capability: the registered official providers in
   * {@link MENU_ORDER}, then every other registered provider in Host order,
   * and the selected id when the Host does not register it. Before the list
   * arrives, the menu holds only the selected id.
   */
  private options(capability: keyof ProviderList, selected: string): WebProviderOption[] {
    const registered = this.providers?.[capability]
    if (registered === undefined) return selected === '' ? [] : [{ id: selected, missing: false }]
    const first: readonly string[] = MENU_ORDER[capability]
    const ordered = [
      ...first.flatMap(id => registered.filter(info => info.id === id)),
      ...registered.filter(info => !first.includes(info.id)),
    ]
    const options = ordered.map(info => ({
      id: info.id,
      ...info.title === undefined ? {} : { title: info.title },
      ...info.description === undefined ? {} : { description: info.description },
      missing: false,
    }))
    if (selected !== '' && !registered.some(info => info.id === selected)) options.push({ id: selected, missing: true })
    return options
  }

  /** Whether the Host reports `id` as registered, or has not answered yet. */
  private registered(capability: keyof ProviderList, id: string): boolean {
    return this.providers === undefined || this.providers[capability].some(info => info.id === id)
  }

  private searchKind(): WebSearchKind {
    const id = this.selected('searchProvider')
    if (id === '' || !this.registered('search', id)) return 'none'
    if (id === PROVIDER_IDS.apiSearch) return this.api.shell().available ? 'deepseek' : 'none'
    if (id === PROVIDER_IDS.legacySearch) return this.legacy.shell().available ? 'legacy' : 'none'
    return this.providers === undefined ? 'none' : 'plugin'
  }

  private fetchKind(): WebFetchKind {
    const id = this.selected('fetchProvider')
    if (id === '' || !this.registered('fetch', id)) return 'none'
    if (id === PROVIDER_IDS.localFetch) return 'local'
    if (id === PROVIDER_IDS.apiFetch) return this.api.shell().available ? 'deepseek' : 'none'
    return this.providers === undefined ? 'none' : 'plugin'
  }

  /** The reference the key control addresses, from the legacy settings or the default. */
  private ref(): string {
    return this.scopes.legacy.getSnapshot().value?.apiKeyEnv || DEFAULT_API_KEY_REF
  }

  /** Whether the page shows the key control. */
  private keyShown(): boolean {
    return this.searchKind() === 'legacy'
  }

  /**
   * Drop the key draft once the page no longer shows the control or the
   * control addresses another reference, so a draft is never written under
   * another reference or under one no control shows.
   */
  private dropStaleKeyDraft(): void {
    if (this.selection.field(API_KEY_FIELD).text === '') return
    if (this.keyShown() && this.draftRef === this.ref()) return
    this.droppingDraft = true
    try {
      this.selection.actions().edit(API_KEY_FIELD, '')
    } finally {
      this.droppingDraft = false
    }
  }

  /**
   * Stage a key draft for the reference the control addresses now.
   * @param text - the draft text.
   */
  private editKey(text: string): void {
    // The page shows no key control, so a draft would belong to no reference.
    if (!this.keyShown()) return
    this.draftRef = this.ref()
    this.selection.actions().edit(API_KEY_FIELD, text)
  }

  private projection(): WebSearchCardState {
    const primary = this.selection.shell()
    const served = [primary, this.api.shell(), this.legacy.shell()].filter(item => item.available)
    const shell: SettingsFormShell = {
      available: primary.available,
      writable: served.every(item => item.writable),
      dirty: served.some(item => item.dirty),
      invalid: served.some(item => item.invalid),
      saving: served.some(item => item.saving),
      failed: served.some(item => item.failed),
    }
    const searchSelected = this.selected('searchProvider')
    const fetchSelected = this.selected('fetchProvider')
    const base = this.scopes.web.getSnapshot().base as WebProviderSelection | undefined
    return {
      ...shell,
      selectionBlocked: shell.invalid || shell.failed,
      providersFailed: this.providersFailed,
      search: {
        selected: searchSelected,
        options: this.options('search', searchSelected),
        kind: this.searchKind(),
        auto: base?.searchProvider === undefined,
      },
      fetch: {
        selected: fetchSelected,
        options: this.options('fetch', fetchSelected),
        kind: this.fetchKind(),
        auto: base?.fetchProvider === undefined,
      },
      count: this.api.field('count'),
      messagesBaseURL: this.legacy.field('baseURL'),
      maxUses: this.legacy.field('maxUses'),
      legacyKey: this.keyShown() ? { ...this.selection.field(API_KEY_FIELD), ...this.credential } : undefined,
    }
  }

  /**
   * Re-read the registered providers. Only the latest read publishes; a failed
   * read keeps the previous list and marks the page's provider list as failed
   * until a later read succeeds.
   */
  refreshProviders(): void {
    void this.readProviders()
  }

  private async readProviders(): Promise<void> {
    if (this.disposed) return
    const sequence = ++this.providerReadSequence
    const response = await this.ctx.remote.web.listProviders()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
    if (this.disposed || sequence !== this.providerReadSequence) return
    if (response.ok) this.providers = response.value
    this.providersFailed = !response.ok
    this.publish()
  }

  /** Clear the old reference's answer and invalidate its pending reads. */
  private resetCredentialReference(ref: string): void {
    this.credential = { ref, configured: false, writable: true }
    this.credentialReadSequence++
  }

  /** Combine settings publications, including connection-reset refreshes, into one credential read. */
  private queueCredentialRead(): void {
    if (this.credentialReadQueued) return
    this.credentialReadQueued = true
    queueMicrotask(() => {
      this.credentialReadQueued = false
      void this.readCredential()
    })
  }

  /**
   * Ask the credentials domain about the reference the key control currently names.
   *
   * Only the latest read publishes its answer, and only while its reference
   * is unchanged. A write's readback retains its own result even if
   * another read starts or the reference changes.
   * @param written - a reference a save just wrote, asked about in the same read.
   * @returns the answer by reference, or undefined after failure or disposal.
   */
  private async readCredential(written?: string): Promise<CredentialViews | undefined> {
    if (this.disposed) return
    const ref = this.ref()
    if (ref !== this.credential.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      this.resetCredentialReference(ref)
      this.store.set(this.projection())
    }
    const sequence = ++this.credentialReadSequence
    const names = [...new Set([ref, ...written === undefined ? [] : [written]])]
    const response = await this.ctx.remote.credentials.describe(names)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
    if (this.disposed || !response.ok) return
    const views: CredentialViews = response.value
    if (sequence !== this.credentialReadSequence) return views
    if (ref !== this.ref()) {
      // The reference changed outside a publication: drop this answer and read the new one.
      this.publish()
      return views
    }
    const view = views[ref]
    // An unknown reference is treated as writable: the control stays usable
    // and the Host is what refuses, rather than the page guessing a refusal.
    const next: CredentialState = { ref, configured: view?.configured ?? false, writable: view?.writable ?? true }
    if (next.configured !== this.credential.configured || next.writable !== this.credential.writable) {
      this.credential = next
      this.publish()
    }
    return views
  }

  /**
   * Re-read after the Host reports a change to the reference this page watches.
   *
   * A key can be written from somewhere else — the Models page addresses the
   * same reference — and no settings section changes when it is, so without
   * this the badge keeps reporting a state the Host already replaced.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): WebSearchCardFace {
    return {
      hooks: { webSearchCard: this.store },
      edit: (field, text) => {
        if (field === 'legacyApiKey') { this.editKey(text); return }
        if (field === 'messagesBaseURL' || field === 'maxUses') {
          this.legacy.actions().edit(field === 'messagesBaseURL' ? 'baseURL' : field, text)
          return
        }
        this.api.actions().edit(field, text)
      },
      resetField: (field) => {
        const form = field === 'messagesBaseURL' || field === 'maxUses' ? this.legacy : this.api
        form.actions().resetField(field === 'messagesBaseURL' ? 'baseURL' : field)
      },
      selectProvider: (field, id) => { this.select(field, id) },
      retryProviders: () => { this.refreshProviders() },
      resolveText: text => this.ctx.locale.resolveText(text),
      save: () => { void this.save() },
      discard: () => {
        for (const form of [this.selection, this.api, this.legacy]) form.actions().discard()
      },
    }
  }

  /**
   * Stage one provider selection. Automatic selection and a target equal to
   * the composed value clear the override, so the deployment default keeps
   * applying.
   * @param field - the selection field.
   * @param id - the provider id to select, or the empty string for automatic selection.
   */
  private select(field: keyof WebProviderSelection, id: string): void {
    const composed = (this.scopes.web.getSnapshot().base as WebProviderSelection | undefined)?.[field]
    if (id === '' || composed === id) this.selection.actions().resetField(field)
    else this.selection.actions().edit(field, id)
  }

  /**
   * Save the API section before the selection, so a selection takes effect
   * only after the settings it uses have landed. A refused section stops the
   * selection from saving and keeps every remaining draft for correction. The
   * key draft's reference is fixed when the selection save plans its writes,
   * so a provider change during the save does not redirect a key the save
   * already planned.
   * @returns settlement after every attempted write.
   */
  private async save(): Promise<void> {
    const state = this.projection()
    if (!state.available || state.invalid || state.saving) return
    for (const form of [this.api, this.legacy]) {
      if (!form.shell().available || !form.shell().dirty) continue
      await form.save()
      if (form.shell().failed) return
    }
    if (!this.selection.shell().dirty) return
    this.savingRef = this.draftRef
    await this.selection.save()
  }

  /**
   * Write the staged key under the reference its draft belonged to when the
   * save started, then re-read whether the Host now holds it.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(value: string): Promise<boolean> {
    const ref = this.savingRef
    // Refusals surface through the re-read below: the Host is the only
    // authority on whether the key now exists.
    await this.ctx.remote.credentials.set(ref, value)
    return (await this.readCredential(ref))?.[ref]?.configured ?? false
  }

  /** Release subscriptions and prevent queued reads or late answers from publishing. */
  dispose(): void {
    this.disposed = true
    for (const off of this.unsubscribe) off()
    for (const form of [this.selection, this.api, this.legacy]) form.dispose()
  }
}
