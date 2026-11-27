/** Staged host list of a provider row, using the shared Plugins form model. */
import { SettingsFormModel, type SettingsFormScope, type SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The live-editable field of a forge provider's Config. */
export interface HostSettings {
  hosts: string[]
}

/** The saved and staged host lists with the shared form status. */
export interface HostFormState extends SettingsFormShell {
  /** Hosts the provider serves, as its configuration lists them. */
  readonly saved: readonly string[]
  /** Hosts a save would store: `saved` while nothing is staged. */
  readonly draft: readonly string[]
}

/** Why a typed host was not staged. */
export type HostProblem =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'duplicate'; readonly host: string }
  | { readonly kind: 'taken'; readonly host: string }

/** What a provider row's host list offers its page. */
export interface HostFormActions {
  /**
   * Stage one more host. The text is a host name with an optional port, or a URL, of which only the host is taken.
   * @param text - what the reader typed.
   * @returns undefined once staged or for blank text, else why the host was refused.
   */
  readonly add: (text: string) => HostProblem | undefined
  /** Stage the removal of a host; the last host stays. */
  readonly remove: (host: string) => void
  /** Write the staged list, then read back what the Host accepted. */
  readonly save: () => void
  /** Drop the staged list. */
  readonly discard: () => void
}

/**
 * A host name with an optional port. The providers' Config holds the same rule and decides what a save stores; this
 * copy only answers before a save.
 */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i

/** A URL with a scheme, of which a typed host keeps only the authority. */
const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Read the host a reader typed: a URL gives its host and port, any other text is taken as written, in lowercase.
 * @param text - what the reader typed.
 * @returns the lowercase host, which may still be malformed.
 */
export function typedHost(text: string): string {
  const trimmed = text.trim()
  const host = URL_FORM.test(trimmed) && URL.canParse(trimmed) ? new URL(trimmed).host : trimmed
  return host.toLowerCase()
}

function listed(text: string): string[] {
  return text.split('\n').filter(host => host !== '')
}

/** Stages additions and removals of a provider's hosts until the reader saves them as one list. */
export class HostSettingsForm {
  private readonly form: SettingsFormModel<HostSettings>
  private readonly state: SnapshotStore<HostFormState>

  /**
   * @param scope - Host-backed configuration form of the provider row.
   * @param taken - hosts the other providers serve now, which this row cannot add.
   */
  constructor(private readonly scope: SettingsFormScope<HostSettings>, private readonly taken: () => readonly string[]) {
    this.form = new SettingsFormModel(scope, [{
      field: 'hosts',
      format: value => (value as readonly string[] | undefined ?? []).join('\n'),
      // `remove` keeps the last host, so every staged text lists at least one.
      parse: text => ({ kind: 'set', value: listed(text) }),
    }])
    this.state = this.form.bind(() => ({
      ...this.form.shell(), saved: this.scope.getSnapshot().value?.hosts ?? [], draft: listed(this.form.field('hosts').text),
    }))
  }

  /**
   * Build the registration face for the row page.
   * @returns the list observable with the add, remove, save, and discard actions.
   */
  inject(): { hooks: { hostForm: SnapshotStore<HostFormState> } } & HostFormActions {
    const { edit, save, discard } = this.form.actions()
    const stage = (hosts: readonly string[]): void => { edit('hosts', hosts.join('\n')) }
    return {
      hooks: { hostForm: this.state },
      add: (text) => {
        const host = typedHost(text)
        if (host === '') return undefined
        if (!HOST.test(host)) return { kind: 'invalid' }
        const { draft } = this.state.getSnapshot()
        if (draft.some(other => other.toLowerCase() === host)) return { kind: 'duplicate', host }
        if (this.taken().some(other => other.toLowerCase() === host)) return { kind: 'taken', host }
        stage([...draft, host])
        return undefined
      },
      remove: (host) => {
        const { draft } = this.state.getSnapshot()
        if (draft.length > 1) stage(draft.filter(other => other !== host))
      },
      save,
      discard,
    }
  }

  /** Release the accepted-value subscription. */
  dispose(): void { this.form.dispose() }
}
