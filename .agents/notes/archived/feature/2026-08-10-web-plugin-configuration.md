# Agent Note: Plugin configuration in the web settings page

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-web-plugin-configuration.zh.md)

> The three sections, the layering, and the staged-save form remain current. The Host allowlist and the unkeyed card list are superseded by the [plugin-owned settings surface](../architecture/2026-08-12-plugin-owned-settings-surface.md): every registered namespace is served, and cards are keyed on the namespace they edit.

## Problem

Everything a plugin can be configured with lived in `cordis.yml`. A user who wanted a longer shell timeout, a different search endpoint, or fewer parallel tool calls had to find the composition file, know its shape, and restart — while the Models page had shown for months that a settings namespace can be edited from the browser and take effect immediately.

The seam that made the Models page possible was already general: any plugin may register a namespace, and `settings.describe` serves its schema, its layers, and its revision. What was missing was on the two ends. No plugin outside the LLM adapters and the permission service had registered one, and there was no surface for a namespace that is not a model provider.

## Decision

Three host-plane plugins register their own settings namespace, and one browser-side Plugins section aggregates feature-owned tabs. Its configurable tab renders whatever editable settings the deployment exposes.

**Layering, unchanged.** A section resolves as schema defaults → the plugin's composition entry → the user layer. Each plugin passes its `cordis.yml` entry as the `base` and reads its config through a source thunk, so a stored change reaches the next use and a detaching settings provider leaves the composition entry running. Constraints the schema cannot express — positive and finite, the timer bound on `graceMs`, the parallel cap being a positive integer — become the section validator, so a bad value is refused at the write instead of at the next command.

**The shell namespace names the capability, not an implementation.** `SHELL_SETTINGS_NAMESPACE` is exported by `@deepseek-ai/dsh-shell` because a host composes exactly one provider of `ctx.shell`: the win32 layer swaps the POSIX rows for the pwsh ones, and mounting both fails loud on a duplicate service registration. Both families therefore register the same namespace with their own schema and entry without ever colliding, and a `settings.yaml` carried between platforms keeps resolving on both — schemastery objects preserve keys the active schema does not declare.

**A section is a subset when the plugin config is bigger than what a user owns.** `agent-loop` exposes only `maxParallelToolCalls`; its `agents` array is consumed once when the service starts, so a stored change there could only look like it had an effect.

**The provider projects, rather than captures.** `web-search-deepseek` hands its provider a thunk instead of an options value, so an endpoint or model change reaches the next search without re-registering the provider — which would make the web seam's provider selection observable to the user as a flicker.

**Exposure stays a Host allowlist.** The three namespaces join `WEB_SETTINGS_NAMESPACES`; registration alone still never crosses the transport, and a namespace absent from that list answers `settings-not-exposed` exactly as an unregistered one does.

**The configurable tab knows no namespace.** `dsh-client-ui-settings-plugins` owns the Plugins section, contributes its `configurable` page through `settings.plugins.tab`, and declares a nested `settings.plugin.item` slot there. It renders the cards registered into that nested slot, so a plugin that ships a browser half owns its card and its controls. Each card binds its namespace through the client settings scope, which gained the two things a form needs: the raw `user` layer, whose key PRESENCE is what marks a field overridden, and `unset`, which clears one field back to the composition layer. A card renders nothing while its namespace is unavailable, so a deployment that does not compose the owning plugin shows no trace of it.

**A card stages its edits and writes them on save.** Controls hold no draft of their own: the card's form owns the staged text, every control renders it, and only **Save** turns it into document mutations. A settings write is durable and revision-fenced, so a control that committed as it settled spent a revision on a value the user had not decided to store and could not preview; the reset stages the composed default the same way. Because the Host's validators own the constraints no schema can express, the form reads the section back after writing and reports a save that did not land instead of predicting the outcome, keeping those drafts for the user to correct. The credential control is staged with the rest even though it writes through the credentials domain, so one save covers everything the card shows.

## Alternatives considered

- **A registration-time exposure declaration replacing the allowlist.** The honest shape — the namespace's owner declares its own exposure, and a plugin distributed outside this repository can surface its configuration without a change in `packages/host/apiproxy`. Deferred because it changes the seam contract, every existing registration site, and the anti-enumeration semantics at once, and because a plugin exposing an arbitrary schema needs a fail-closed redaction path first: a secret reachable only through a union or transform is currently returned verbatim.
- **A generic schema-driven form renderer.** Declined again for the reason recorded in the [web-config-plane note](../architecture/2026-07-30-web-config-plane.md): field truth without a presentation vocabulary produced an unusable card. Three plugins of hand-written controls cost about the same and read better, and the slot keeps the fourth plugin from having to negotiate with this package.
- **Editing preset-mounted plugins from this page.** Out of scope, and not merely unbuilt: a preset's rows carry their configuration inline in `agent.cordis.yml` and cannot register a settings namespace at all, because a second session mounting the same preset would fail on a duplicate registration. A user layer shared across presets would also overwrite the fields a preset uses to define its agent's identity — its persona text, its delegation wiring — which are per-preset by design.
- **One namespace per executor package instead of the capability-named `bash`.** Declined because the composed executor differs by platform while the settings document does not: a user who set a timeout on macOS would silently lose it on Windows.
- **Writing the search key into the settings section.** Declined because the literal would then have to ride a `describe` response to be rendered. The card reports only whether a key is configured and writes through the credentials domain, addressed by the reference the section names.
- **Committing each control as it settles, with no save.** Built first, and replaced: blur is not a decision. It spent a namespace revision per control, gave the user nothing to preview or undo before the write, and left an invalid draft silently discarded — a value the Host's validator refuses simply snapped back with no reason given. One save per card makes the write a gesture the user performs.
- **Letting the provider read its options per property.** The thunk was read at each use site so read sites could stay unchanged, which quietly broke the contract the constructor states: `search()` awaits credential resolution and then reads the endpoint, model, and budget, so a settings write landing inside that await sent the key resolved from the old section to the endpoint named by the new one. Each operation now snapshots once at its entry and threads that snapshot into credential resolution.
- **Validating the fields in the browser to keep the save honest.** Declined: the constraints live in the owning plugin's section validator, and restating them here would make two homes for one rule that could disagree per release. The card checks only what its own control can decide — that a numeric draft is a number — and lets the Host answer for the rest, which is why the save reads the section back.

## Consequences

A user edits the shell's command timeout and output cap, the agent loop's parallel tool-call cap, and the search provider's key, endpoint, and per-request budget from the settings page, with each field marking whether they set it and offering a reset.

Two costs are real. Adding a fourth plugin still requires an entry in the apiproxy allowlist, so the page's reach is a Host decision rather than a plugin's. And the plugins the web deployment moved into the agent plane — the file tools, the skills, compaction, the todo tool — appear nowhere here, which is most of what a user might expect to find; their configuration remains the preset editor's.

The bash and pwsh executors now expose `config` as a getter over a source thunk rather than a readonly field. Every read site was already per-call, so nothing else changed, but a subclass that captured `this.config` at construction would silently pin the composition entry.

`verify-cordis-config` requires every `packages/client` package's `./client` export and `dsh.client` declaration to agree in both directions. Without that check, a stale manifest field can leave the composition row and empty node half active while the browser roster silently omits the package. The check is scoped to that group because a Host package's `./client` export is the typed wire face its browser consumers import, not a plugin the roster serves.
