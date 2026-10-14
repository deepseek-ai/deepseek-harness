# Agent Note: DeepSeek account models come from the account listing and gate by client version

Status: implemented

English | [中文](2026-09-24-deepseek-account-remote-model-catalog.zh.md)

## Problem

The account route's catalog was deployment configuration: a build advertised the models it shipped with, a new model reached users only through a release, and nothing kept an older build from requesting a model it cannot drive. The account service publishes per-account model metadata at `GET /models`, and that listing can name models an older build does not understand.

## Decision

- [`llm-deepseek-account`](../../../../packages/llm/llm-deepseek-account/README.md) loads the listing lazily for each credential, waits for it once up to `modelsTimeoutMs`, refreshes it in the background after `modelsMaxAgeMs`, keeps the last good listing when a load fails or returns no model, and serves the bundled catalog before any listing loads. The cache lives in memory and is keyed by endpoint and token fingerprint, so per-account rollouts stay separate.
- A listed model is available when its `client_requirements["deepseek-harness"].min_version` is at most the current DeepSeek Harness version in semantic-version order. Without that declaration, only ids the built-in catalog knows are available; the others stay hidden, because a client cannot tell which future version supports them. A request for a refused listed model fails before network I/O with `CLIENT_UPGRADE_REQUIRED` or `MODEL_UNSUPPORTED`.
- Listed capabilities replace bundled ones field by field; the bundled entry keeps client-side knowledge such as tool-update mode and image budgets; `modelOverrides` applies last and reuses the `models` entry fields and validation. `max_output_tokens` bounds the request default instead of becoming it.
- The shared transport gains only two provider hooks, `connect` and `admit`; listing, gating, and merging stay in the account package.

## Alternatives considered

**Server-side filtering by client version only.** Codex sends `client_version` and lets its backend drop models. An older build then cannot show that a newer version supports a model, and a listing that omits a declaration would expose an unknown model.

**Default parameters for unknown models.** Reasonix and Pi drive unknown ids with generic defaults, and MiniMax treats that as a defect. A model that needs client changes would run with the wrong behavior.

**Whole-listing validation.** Codex, ZCode, and Kimi reject the whole listing on one bad field. One malformed row would then send every account back to the bundled catalog.

**Persisting the last good listing.** A durable cache adds a persistence format and its migration duty; the bundled catalog already covers offline starts.

**Keeping `models` with merge-by-id semantics.** The API-key route's `models` replaces its catalog, so the same field name with merge semantics would invert its meaning between sibling routes.

**Generalizing the shared transport.** Per-model effort levels, an output-capability field, and catalog-change announcements would widen the Messages package for one consumer. The listed effort levels match the bundled defaults, and a model that needs different ones needs a release, which the gate enforces.

## Consequences

- An older build never offers a model it does not know unless the service declares a minimum version that build satisfies, and the service must declare `min_version` for a future build to show that an upgrade enables a model.
- A modified client can still request any id; the service enforces version floors only if it rejects such requests itself.
- The first account access after sign-in may wait up to `modelsTimeoutMs`; an offline start uses bundled capabilities until a listing loads; a listing change during a running process reaches the Web picker at its next catalog refresh.
