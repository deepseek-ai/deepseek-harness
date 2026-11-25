# Agent Note: Deployment-supplied pi-ai providers as provider rows

Status: implemented

English | [中文](2026-11-23-pi-ai-deployment-provider-rows.zh.md)

## Problem

Every pi-ai provider route lives in one field: the `providers` dict of the `llm-pi-ai` row's config. A patch that sets a row's `config` replaces the whole config of the layers before it. The Models page stores a person's providers as an override of that row in the profile patch, and a deployment that supplies providers to every profile of a machine writes its home patch, which applies after the profile patch. The two therefore write the same field in two layers, with two results:

- The home patch's dict replaces the person's dict, so the person's providers stop serving.
- The configuration editor refuses every later save of that row, because the composed config differs from what it would store (`Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay`).

The same holds for a `--patch` overlay and for any layer that adds a provider after the profile patch.

## Decision

A layer that adds a provider writes a row of its own, and the dict stays as it is.

- [`@deepseek-ai/dsh-llm-pi-ai/provider`](../../../../packages/llm/llm-pi-ai/src/provider-row.ts) is a second plugin of the adapter package. Its config is the route key in `provider` and the profile fields of a dict entry beside it, built from the same field schemas, each one live.
- The row registers its route through [`ctx.piAiProviders`](../../../../packages/llm/llm-pi-ai/src/registry.ts), which the adapter row provides. The adapter serves the registered routes together with its dict's.
- Of the declarations that name one route, the one that comes last in the composed entry list is in effect. The dict takes the position of the adapter's row, so a row that a home patch or an overlay adds replaces the dict entry of the same route, and that entry serves again when the row leaves. This is the precedence patches already have: the later layer decides.
- The configurable-provider directory addresses a route that a row serves by that row (`settingsNs` is the row id, `settingsPath` is empty) and every other route by its dict entry.
- Settings and the configuration editor are unchanged. The [Models page](../../../../packages/client/ui-settings-models/src/client/store.ts) recognizes a provider row from what settings already sends: the row's form declares the fields of a dict entry's form, because both are built from the same field schemas. It keeps its reads and writes of the dict, lists a route that a row serves beside them without a deletion, and opens it as a pi-ai card at the root of the row's namespace. A typed key is stored under the credential reference the row names; a changed field goes to the configuration editor, which refuses a row that a home patch or an overlay adds.

The dict, the stored profile patches, and the page's writes of the dict are unchanged, so no stored configuration is converted and no interface is removed.

## Alternatives considered

- **Every provider as a row, without the dict.** Each layer then adds, changes, or removes one route, and a person's providers and a deployment's are symmetric. It removes the dict that released profile patches store, so it needs a conversion of every stored profile at launch, a refusal for files the launcher does not own, an upgrade guide, generic operations that add and remove plugin rows from a settings page, and a Models page that drafts rows. An implementation of it added about 5,500 lines, tests and documents included, across the launcher, the configuration editor, settings, its Remote controller, and the page. The problem above needs none of that: only the layer that currently overwrites the dict has to stop writing it.
- **Deep-merging `config` across patch layers, or a path-addressed patch operation.** Either changes what every patch of every plugin means, or adds a patch form that all layers must learn, to serve one dict. A second provider source in the adapter is local to the package that owns the dict.
- **A second `llm-pi-ai` row for the deployment.** The adapter provides one directory and one model-discovery registration per composition; a second row fails to start with `DUPLICATE_DIRECTORY`.
- **A dedicated file for deployment providers beside the patch files.** It adds a configuration source that the Loader, hot reload, and the configuration editor do not know.
- **Letting both declarations of one route serve, told apart by display name.** The route key is what a request, a Session record, and the default-model setting name, and pi-ai dispatches on it, so one key selects one profile. A deployment that offers a provider beside a person's own of the same vendor gives its row another route key and a `displayName`. Renaming a colliding key automatically was rejected: the key would change when the other layer appears or leaves, while stored Sessions and the default model point at it.
- **Marking a deployment's providers on the Models page.** A tag and a read-only card for a row that a later layer decides need the configuration editor to report which layer decides each row, and settings and its Remote controller to carry that to the page. The configuration editor already refuses the write, so those packages stay as they are and the card shows the refusal. Whether a settings page may edit a row that the home patch decides is a question for the configuration editor, apart from this adapter.
- **Telling the page which rows are provider rows through a new field.** A field on the directory entry of `dsh-llm`, or the plugin name of each namespace forwarded by settings, would name the row's adapter. The form that settings already sends identifies the row, so no interface carries it.

## Consequences

- A `providers` dict that cannot start fails the adapter row, and the provider rows wait for the service that row provides, so no pi-ai route serves until the dict is repaired. A provider row that cannot start fails alone.
- A row under a route key that names no installed pi-ai provider inherits no catalog: it declares `api`, `baseURL`, and `models`.
- A dict entry behind a row of the same route serves nothing and is not shown by the Models page while the row runs.
- Nothing on the Models page tells a deployment's provider from a person's own apart from the missing delete control, and a changed field of a row that a home patch or an overlay adds is refused only when it is saved.
- The page treats any namespace whose form declares exactly the fields of a pi-ai profile as a provider row.
- A reconciled configuration can move rows without restarting them. The registry re-evaluates the rows in effect on `app-boot/config-reload`; a composition that reorders rows by another means keeps the previous order until a row registers, changes, or is withdrawn.
- A home patch that overrides the config of the `llm-pi-ai` row replaces the stored dict, and the configuration editor refuses a save of that row.
