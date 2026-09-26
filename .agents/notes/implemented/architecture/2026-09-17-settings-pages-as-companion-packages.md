# Agent Note: Settings pages as companion packages

Status: implemented

English | [中文](2026-09-17-settings-pages-as-companion-packages.zh.md)

## Problem

The four official settings pages — shell, agent loop, Subagent, web search — lived in one client package, `ui-settings-plugins`, beside the Built-in plugins section. Every new built-in page grew that package, and a community bundle that wanted a settings page had no worked example of a page living with the plugin that owns the namespace. Moving each page into the Host package that registers its namespace was considered and does not fit: the shell namespace is registered by the executor families under the sandbox row, the loop package would gain a browser build for one number field, and the Subagent namespaces are registered from a subpath row, which carries no browser half.

## Decision

**A community plugin's settings page lives in its own package's browser half.** It registers into `plugins.bundle.config` or `plugins.row.config`, owns its copy and styles, and reads and writes through `ctx.settingsScope`. Its i18n is the client locale service, as the shipped community bundles already do.

**A built-in namespace's page lives in a companion client package.** `ui-settings-shell`, `ui-settings-agent-loop`, `ui-settings-subagent`, and `ui-settings-web-search` are client-only packages with an empty Host `apply`, one bare-name row each in the web composition's roster, registering into `plugins.item` while the Host serves their namespace. Host packages stay free of browser code; the namespace they edit is spelled as a literal, never imported from the owner.

**The form machinery moves to `ui-primitives`.** `SettingsFormModel` with `settingsNumberField` and `settingsTextField`, `SettingsValueField` and `SettingsSecretField`, and the `SettingsForm` frame are the kit every page renders with; the frame takes its copy as `labels` and the model takes a structural scope, so the baseline package depends on neither a plugin nor its dictionary.

**`settingsScope.whileServed(namespaces, register)` is the registration rule.** A page exists exactly while the Host serves one of its namespaces: the service watches the shared describe mirror, runs the registration when a namespace appears, and disposes it when none is served, so four packages share one rule instead of four copies.

**`ui-settings-plugins` keeps the Built-in plugins section only:** the navigation entry and the tab row feature-owned tabs register into.

## Alternatives considered

**A schema-driven generic form.** Rejected: a generic renderer covers scalar fields and stops at the first dynamic control — the Subagent page's live model catalogue, its cross-field rule, its one-mutation save — and every exception would become a role the schema is not for. Every page is code; a community plugin that ships no page has none.

**Dual-face Host packages for the built-in pages.** Rejected for the reasons above; the companion keeps the option open for a package that can carry a half.

**Copy for the form frame in one shared dictionary.** Rejected: it would couple every page to another plugin's dictionary keys; each page's dictionary carries the few frame strings.

## Consequences

- The Plugins page's Official group lists the same four pages in the same order, from four packages instead of one; their labels and forms are unchanged, so the page goldens hold.
- The cookbook [adding a settings page](../../../../docs/cookbook/adding-a-settings-card.md) shows the community path and names the companion template.
- The client module system's rule stands: a browser half rides the Loader row whose specifier is the bare package name, so a bundle split into subpath rows keeps every page it registers on its root row.
- The shell page's `plugins.item` id is `shell`, where the old package registered `bash`: `subject.id` on an official page is now a discriminator `plugins.detail.*` contributions key on, so the id names the capability the page edits rather than one executor family.

## Testing

Each companion's `tests/apply.client.spec.ts` registers its page while the Host serves the namespace, withdraws it when the Host stops, and collapses on teardown; its card and controller specs carry the page's behavior from the former package. `packages/client/ui-primitives/tests/settings-form-model.client.spec.ts`, `packages/client/ui-primitives/tests/settings-form.client.spec.tsx`, and `packages/client/ui-primitives/tests/settings-fields.client.spec.tsx` pin the kit; `packages/client/ui-settings/tests/while-served.client.spec.ts` pins the registration rule. `apps/web/tests/plugin-config.e2e.ts` exercises the shell and Subagent pages over the real wire.
