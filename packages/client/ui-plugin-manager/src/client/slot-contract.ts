/**
 * The slots the Plugins page declares for other plugins. Three carry a
 * plugin's own configuration: the official plugins listed beside the official
 * bundles, one bundle's configuration on its page, and one row's configuration
 * opened from that row. Three more take contributions to any detail page —
 * its head actions, the badges beside its title, and the sections under its
 * own content — from a plugin that has something to say about bundles, rows,
 * or official plugins it does not own. A registrant merges this contract with
 * `import type` and registers through `ctx.slots`; it never imports this
 * package at runtime.
 *
 * Entries accept `page` for the form with its own save control and `summary`
 * for an official card's one-liner or a row's missing-description fallback.
 * Bundle configuration renders only `page`. A detail contribution is rendered
 * with the subject of the open page and decides from it whether to render at
 * all. The page draws the title, icon, and crumb itself.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The view the page asks a configuration entry for. */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone, as text or inline nodes; `page` renders the form with its save control. */
  readonly view: 'summary' | 'page'
  /** Host-owned configuration values and write actions for this page's entry. */
  readonly form?: ConfigPageForm | undefined
}

/** One row of a bundle as a detail contribution sees it. */
export interface PluginRowRef {
  /** The row id as the bundle's patch declares it. */
  readonly rowId: string
  /** The module the row names. */
  readonly moduleName: string
  /** Whether the row's entry runs. */
  readonly enabled: boolean
}

/** One bundle as a detail contribution sees it: the facts a contribution decides on, never the page's own state. */
export interface PluginPackageRef {
  /** The package name. */
  readonly name: string
  /** The installed version, when the Host reports one. */
  readonly version?: string
  /** Whether the profile's own dependencies hold the package; false for a bundle the installation supplies. */
  readonly installed: boolean
  /** Whether the bundle is switched on. */
  readonly enabled: boolean
  /** The rows the bundle declares. */
  readonly rows: readonly PluginRowRef[]
}

/** What a detail page is about: a bundle, one row of a bundle, or an official plugin listed by its `plugins.item` id. */
export type PluginsSubject =
  | { readonly kind: 'bundle'; readonly pkg: PluginPackageRef }
  | { readonly kind: 'row'; readonly pkg: PluginPackageRef; readonly row: PluginRowRef }
  | { readonly kind: 'item'; readonly id: string }

/** The owner props every detail contribution is rendered with. */
export interface PluginDetailProps {
  /** The subject of the open page; an entry renders null for a subject it has nothing for. */
  readonly subject: PluginsSubject
}

/** One user-requested bundle activation and navigation to its configuration page. */
export interface PluginActivationOwnerProps {
  readonly packageName: string
  /** Dismiss guidance for this activation. */
  readonly onDismiss: () => void
  /** Dismiss guidance and open this bundle's detail page. */
  readonly onOpenDetails: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Optional guidance after the user enables a bundle from the list, keyed by npm package name. */
    'plugins.bundle.activation': { kind: 'keyed'; scope: 'root'; owner: PluginActivationOwnerProps }
    /**
     * One official plugin the Plugins page lists in its Official group after
     * the official bundles: `label` is the card's title and `order` its place.
     * The page renders the entry as the card's one-liner (`view: 'summary'`)
     * and, once the card is opened, as the body of the plugin's own page
     * (`view: 'page'`). OCCUPIED by the official settings pages, one companion
     * package per host-plane namespace; a bundle's configuration belongs in
     * `plugins.bundle.config` or `plugins.row.config` instead.
     */
    'plugins.item': { kind: 'list'; scope: 'root'; owner: PluginConfigViewProps }
    /**
     * A bundle's own configuration, keyed by the bundle's package name and
     * rendered on the bundle's page between its description and its rows
     * (`view: 'page'` only).
     */
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
    /**
     * The configuration of one row a bundle declares, keyed by
     * `<package name>#<row id>` with the row id as the bundle's patch declares
     * it: the row on the bundle's page gains a configure control that opens
     * the entry's page, headed by the plugin's display title and description.
     * An absent description falls back to the entry's `view: 'summary'`.
     */
    'plugins.row.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
    /**
     * Controls at the head of a detail page, before the page's own switch and
     * uninstall, rendered with the page's subject. An entry renders null for a
     * subject it has no control for.
     */
    'plugins.detail.actions': { kind: 'list'; scope: 'root'; owner: PluginDetailProps }
    /**
     * Tags beside a detail page's title, after the version, beta, and problem
     * tags the page draws itself, rendered with the page's subject.
     */
    'plugins.detail.badge': { kind: 'list'; scope: 'root'; owner: PluginDetailProps }
    /**
     * Sections under a detail page's own content: after the rows on a bundle's
     * page, after the configuration on a row's or an official plugin's page.
     * An entry draws its own section chrome and renders null for a subject it
     * has nothing for.
     */
    'plugins.detail.section': { kind: 'list'; scope: 'root'; owner: PluginDetailProps }
  }
}

/** Reactive page values and commands supplied by the configuration page owner. */
export interface ConfigPageForm {
  /** Accepted Host values; refreshed by the page owner. */
  readonly state: ConfigFormSnapshot<Record<string, unknown>>
  /** Submit all field edits together with the revision the editor read. */
  readonly mutate: ConfigForm<Record<string, unknown>>['mutate']
}
