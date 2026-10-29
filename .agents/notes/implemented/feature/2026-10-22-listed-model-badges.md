# Agent Note: Model selector badges come from the model listing

Status: implemented

English | [中文](2026-10-22-listed-model-badges.zh.md)

## Problem

The Web model selector showed `1017` beside `DeepSeek-V4.1-Flash` through a dedicated client package that matched two DeepSeek providers, one model id, and one exact catalog name. Changing or retiring that release marker, or labeling another model, required a client release, while both DeepSeek routes already read model metadata from the service's `GET /models` listing.

## Decision

- Each `/models` entry may declare `badge: { text, tone }` under `client_metadata["deepseek-harness"]`, keyed like `client_requirements` by the User-Agent product token. `client_metadata` holds client-specific data that every build may ignore, so the public model fields stay unchanged and later DeepSeek Harness fields join the same object. `text` uses the package-metadata `LocalizedText` form: one string, or translations keyed by lowercase language id that include `en`. Each text is trimmed and holds 1 to 12 user-perceived characters on one line; controls, Unicode line separators, bidi controls, and text made only of whitespace or default-ignorable characters are rejected.
- `tone` is `neutral`, `info`, `success`, or `warning`: the `Tag` palettes for a plain fact, a highlight, a benefit, and attention. The shipped release marker used `info`; the surveyed selectors draw plan and capability tags neutral, new features with an accent, and usage hints in a warning color. `danger` and `solid` keep their failure and selection meanings.
- [`parseModelListing`](../../../../packages/llm/llm-deepseek/src/listing.ts) decodes the badge beside the entry's other declarations, and [`resolveListedCatalog`](../../../../packages/llm/llm-deepseek/src/listed-catalog.ts) keeps the badges of offered models; both routes attach them through `catalogModelInfo`. An absent or `null` value at any level of that path shows no badge, and an absent or unrecognized tone shows `neutral`. A level that is not an object or an unreadable badge drops the badge, which is reported with the listing's other problems and never hides its model.
- `LlmModelInfo.badge` and `ModelCatalogModel.badge` carry the badge from discovery through the Host model catalog to the browser. `resolveModelInfo` omits it, and no model request, Session event, or model-facing tool reads it.
- [`ui-model-selection`](../../../../packages/client/ui-model-selection/README.md) renders the badge before the catalog name in the trigger and after it in the root-menu value and each option, resolving its text with `ctx.locale.resolveText`. A `conversation.input.model.label` contribution replaces the name and badge together and receives the badge in its owner props.
- The build ships no badge of its own: a route before its first listing shows none. The API-key route does not follow listings for customized catalogs or non-official endpoints; the account route follows the origin of its configured `baseURL`, including custom endpoints. The fixed `ui-deepseek-model-label-1017` package and its Web bundle row are removed.
- After first use, the credential-scoped cache refreshes automatically at `modelsMaxAgeMs` (ten minutes by default) and publishes changed catalogs through `llm/models-updated`. Successful listings replace all badge metadata, so omission or `null` clears an old badge. Failed refreshes retain the last successful listing, including badges: a failed request does not establish that the server withdrew a badge. This avoids independent polling in every browser. A zero interval preserves access-only refresh.

## Alternatives considered

**A top-level `badge` field.** The public `/models` fields describe model capabilities and limits for every client, while the badge is DeepSeek Harness release and campaign copy. A top-level field reads as a model attribute that other clients could start rendering, after which the service could no longer change or retire it freely, and two clients could not show different badges.

**`badge` inside `client_requirements["deepseek-harness"]`.** It adds no top-level field, and released builds ignore an extra key there. But an unreadable requirement hides its model on every build, released ones included, so a serializer that writes the emptied object as `null` after a badge is retired would hide the model. Requirements gate availability; display data must stay ignorable.

**A narrower map such as `client_presentation` or `client_annotations`.** These names limit the object to display data or descriptive notes, so the next client-specific field of another kind, such as a default, would need another top-level field; `client_metadata` takes any field a build may ignore.

**A semantic badge kind mapped to client dictionaries.** OpenCode, ZCode, and DeepSeek-Reasonix translate a closed set of client-owned tag kinds, and none renders text a server sends. A fixed vocabulary cannot express a release code such as `1017`, and each new wording would need the client release the listing exists to avoid. Listing text is provider data, which the [locale-owned copy decision](../architecture/2026-08-23-locale-owned-client-ui-copy.md) renders verbatim; the `LocalizedText` form still lets the service supply translations.

**Accept colors, CSS, or markup from the listing.** No surveyed product accepts styling from a catalog, and arbitrary colors bypass the theme's light and dark palettes and their contrast. A closed tone set maps onto the existing `Tag` palettes, and an unrecognized tone degrades to `neutral`, so a value a newer service adds never removes the text.

**Keep `1017` as a built-in default.** A bundled badge would keep the marker offline and on custom endpoints. Under the listing rule that an absent field keeps the build's value, the service could then remove it only with a special empty value, and old builds would keep the stale marker wherever no listing loads. Shipping no badge makes the listing the only source, so omitting the field removes the badge.

**An expiry or start time on the badge.** The listing cache lives in memory and refreshes on access after `modelsMaxAgeMs`, so a badge the service drops disappears within one refresh. Client-side time windows would add dependence on the client clock without removing reachable staleness.

**Drop the whole entry or listing for a bad badge.** OpenCode drops a model whose catalog status it cannot decode, and Codex fails its catalog decode on one unknown enum value. A badge is presentation only, so a bad one is dropped by itself.

**A DeepSeek-specific badge Remote beside the catalog.** Keeping the badge out of `LlmModelInfo` would need a second Remote, a second client fetch, and agreement between two caches about which models exist. One optional field on the existing catalog reaches every placement in one load.

## Consequences

- The service changes, localizes, or removes a badge without a client release; a running client shows the change after its next listing refresh and catalog reload.
- A condition that older builds must enforce belongs in `client_requirements`; every field under `client_metadata` must be safe for a build that does not read it.
- `deepseek-flash` shows no badge until the service declares one and a listing loads. Customized catalogs and non-official endpoints on the API-key route do not receive listed badges.
- The `/model` popup, the trigger's accessible name, and the Models settings page keep plain names.
- A profile patch that still targets `ui-deepseek-model-label-1017` matches no row and boots with a warning ([upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/model-badge-package-removal/guide.md)).
