/**
 * The web-search page's staged form over three settings namespaces: `web`,
 * whose provider selection the Search API switch writes, `web-search-deepseek`
 * for Messages search, and `web-deepseek-api` for the Search and Fetch APIs.
 *
 * The switch selects `deepseek-search-api` and `deepseek-fetch-api` together, or
 * Messages search with local HTTP fetch. A selection equal to the deployment's
 * composed value clears the override instead of storing a copy of it.
 *
 * The key is the one control that does not live in a section: its literal
 * never rides a response, so the page learns only whether one is configured
 * and writes it through the credentials domain, addressed by the reference the
 * selected API's section names. It is still staged with the rest of the form,
 * so one save covers everything the page shows.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormShell, type SettingsFormScope, type SettingsFormScopeSnapshot,
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

/** Provider ids the switch writes into the web service's selection. */
const PROVIDERS = {
  searchProvider: { api: 'deepseek-search-api', messages: 'deepseek-official' },
  fetchProvider: { api: 'deepseek-fetch-api', messages: 'http' },
} as const

/** Credential reference the providers resolve when a section names none. */
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/** The web service's provider selection. */
export interface WebProviderSelection {
  /** Search provider id. */
  searchProvider?: string
  /** Fetch provider id. */
  fetchProvider?: string
}

/** The Messages search fields this page edits. */
export interface WebSearchSettings {
  /** Credential reference naming the environment key. */
  apiKeyEnv?: string
  /** Messages endpoint; blank inherits the provider default. */
  baseURL?: string
  /** Maximum Messages server-tool uses. */
  maxUses?: number
}

/** The Search and Fetch API fields this page edits. */
export interface WebApiSettings {
  /** Credential reference naming the environment key. */
  apiKeyEnv?: string
  /** Search and Fetch API base with its path prefix; blank inherits the provider default. */
  baseURL?: string
  /** Search API results per search. */
  count?: number
}

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials/set` can affect it; false disables the control. */
  writable: boolean
}

/** What the web-search page renders. */
export interface WebSearchCardState extends SettingsFormShell {
  /** Whether the Host serves both the selection and the Search / Fetch API section. */
  apiSwitchAvailable: boolean
  /** Invalid edits or failed saves that switching APIs must keep visible. */
  apiSwitchBlocked: boolean
  /** Staged switch position: true selects the Search and Fetch APIs. */
  useSearchApi: boolean
  /** Endpoint of the selected API. */
  baseURL: SettingsFieldState
  /** Maximum Messages server-tool uses. */
  maxUses: SettingsFieldState
  /** Search API results per search. */
  count: SettingsFieldState
  /** The staged credential, which starts blank on every load. */
  apiKey: SettingsFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
}

/** The registration-side face the web-search page's slot entry injects. */
export interface WebSearchCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useWebSearchCard. */
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
  /** Stage the API switch: true selects the Search and Fetch APIs, false Messages search with local fetch. */
  setSearchApi: (enabled: boolean) => void
}

/** Settings scopes for the namespaces the page edits. */
export interface WebSearchCardScopes {
  /** The web service's provider selection. */
  web: SettingsFormScope<WebProviderSelection>
  /** Messages search settings. */
  messages: SettingsFormScope<WebSearchSettings>
  /** Search and Fetch API settings. */
  api: SettingsFormScope<WebApiSettings>
}

/** Bridges the three settings scopes and the credentials domain onto the page. */
export class WebSearchCardController {
  private readonly selection: SettingsFormModel<WebProviderSelection>
  private readonly messages: SettingsFormModel<WebSearchSettings>
  private readonly api: SettingsFormModel<WebApiSettings>
  private readonly store: SnapshotStore<WebSearchCardState>
  private readonly unsubscribe: (() => void)[]
  private credential: CredentialState = { ref: '', configured: false, writable: true }

  /**
   * @param scopes - the bound settings scopes for the page's namespaces.
   * @param ctx - the page plugin's context, whose `remote.credentials` namespace
   * answers for the credential the selected section references.
   */
  constructor(
    private readonly scopes: WebSearchCardScopes,
    private readonly ctx: ClientContext,
  ) {
    this.selection = new SettingsFormModel(scopes.web, [
      settingsTextField('searchProvider'), settingsTextField('fetchProvider'),
    ], [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }])
    this.messages = new SettingsFormModel(scopes.messages, [
      settingsTextField('baseURL'), settingsNumberField('maxUses'),
    ])
    this.api = new SettingsFormModel(scopes.api, [
      settingsTextField('baseURL'),
      {
        ...settingsNumberField('count'),
        parse: (text) => {
          if (text.trim() === '') return { kind: 'clear' }
          const value = Number(text)
          return Number.isInteger(value) && value >= 1 && value <= 50 ? { kind: 'set', value } : undefined
        },
      },
    ])
    this.store = createSnapshotStore(this.projection())
    // A staged switch can change which section names the key, without any
    // scope publishing; a scope change can rename the reference itself.
    const publish = () => {
      this.store.set(this.projection())
      if (this.ref() !== this.credential.ref) void this.readCredential()
    }
    this.unsubscribe = [
      ...[this.selection, this.messages, this.api].map(form => form.bind(() => form.shell()).subscribe(publish)),
      ...[scopes.web, scopes.messages, scopes.api].map(scope => scope.subscribe(() => { void this.readCredential() })),
    ]
    void this.readCredential()
  }

  /** Whether the Host serves both sections the switch needs. */
  private switchAvailable(): boolean {
    return this.selection.shell().available && this.api.shell().available
  }

  /** The staged switch position, read from the staged search selection. */
  private searchApi(): boolean {
    return this.switchAvailable() && this.selection.field('searchProvider').text === PROVIDERS.searchProvider.api
  }

  private projection(): WebSearchCardState {
    const primary = this.messages.shell()
    const served = [primary, this.selection.shell(), this.api.shell()].filter(item => item.available)
    const shell: SettingsFormShell = {
      available: primary.available,
      writable: served.every(item => item.writable),
      dirty: served.some(item => item.dirty),
      invalid: served.some(item => item.invalid),
      saving: served.some(item => item.saving),
      failed: served.some(item => item.failed),
    }
    const searchApi = this.searchApi()
    return {
      ...shell,
      apiSwitchAvailable: this.switchAvailable(),
      apiSwitchBlocked: shell.invalid || shell.failed,
      useSearchApi: searchApi,
      baseURL: (searchApi ? this.api : this.messages).field('baseURL'),
      maxUses: this.messages.field('maxUses'),
      count: this.api.field('count'),
      apiKey: this.selection.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    }
  }

  /** The reference the selected API's section names, or the providers' default. */
  private ref(): string {
    return refOf(this.searchApi() ? this.scopes.api.getSnapshot() : this.scopes.messages.getSnapshot())
  }

  /**
   * Ask the credentials domain about the reference the selected section currently names.
   *
   * The answer is stored with the reference it describes: `apiKeyEnv` and the
   * switch can change between the request and its response, and two reads can
   * settle out of order, so a response is published only while it still
   * answers for the reference in force.
   */
  private async readCredential(): Promise<void> {
    const ref = this.ref()
    if (ref !== this.credential.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok || ref !== this.ref()) return
    const view = response.value[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      // An unknown reference is treated as writable: the control stays usable
      // and the Host is what refuses, rather than the page guessing a refusal.
      writable: view?.writable ?? true,
    }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
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
   * Build the face the page's slot registration injects. `baseURL` edits the
   * selected API's endpoint; `maxUses` and `count` edit their own sections.
   * @returns the page's snapshot and its form actions.
   */
  inject(): WebSearchCardFace {
    const formOf = (field: string): { actions(): SettingsFormActions } => {
      if (field === API_KEY_FIELD) return this.selection
      if (field === 'maxUses') return this.messages
      if (field === 'count') return this.api
      return this.searchApi() ? this.api : this.messages
    }
    return {
      hooks: { webSearchCard: this.store },
      edit: (field, text) => { formOf(field).actions().edit(field, text) },
      resetField: (field) => { formOf(field).actions().resetField(field) },
      setSearchApi: (enabled) => { this.select(enabled) },
      save: () => { void this.save() },
      discard: () => {
        for (const form of [this.selection, this.messages, this.api]) form.actions().discard()
      },
    }
  }

  /**
   * Stage both provider selections for one switch position. A target equal to
   * the composed value clears the override so the deployment default keeps
   * applying.
   * @param enabled - true for the Search and Fetch APIs.
   */
  private select(enabled: boolean): void {
    const base = this.scopes.web.getSnapshot().base as WebProviderSelection | undefined
    const actions = this.selection.actions()
    for (const field of ['searchProvider', 'fetchProvider'] as const) {
      const target = PROVIDERS[field][enabled ? 'api' : 'messages']
      if (base?.[field] === target) actions.resetField(field)
      else actions.edit(field, target)
    }
  }

  /**
   * Save the provider sections before the selection, so a switch takes effect
   * only after the endpoint it uses has landed. A refused section stops the
   * selection from saving and keeps every remaining draft for correction.
   * @returns settlement after every attempted write.
   */
  private async save(): Promise<void> {
    const state = this.projection()
    if (!state.available || state.invalid || state.saving) return
    for (const form of [this.messages, this.api]) {
      if (!form.shell().available || !form.shell().dirty) continue
      await form.save()
      if (form.shell().failed) return
    }
    if (this.selection.shell().dirty) await this.selection.save()
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(value: string): Promise<boolean> {
    // Refusals surface through the re-read below: the Host is the only
    // authority on whether the key now exists.
    await this.ctx.remote.credentials.set(this.ref(), value)
    await this.readCredential()
    return this.credential.configured
  }

  /** Release configuration subscriptions. */
  dispose(): void {
    for (const off of this.unsubscribe) off()
    for (const form of [this.selection, this.messages, this.api]) form.dispose()
  }
}

/**
 * The credential reference a section names, or the providers' default.
 * @param snapshot - the section's current scope snapshot.
 * @returns the reference to address.
 */
function refOf(snapshot: SettingsFormScopeSnapshot<{ apiKeyEnv?: string }>): string {
  const declared = snapshot.value?.apiKeyEnv
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
}
