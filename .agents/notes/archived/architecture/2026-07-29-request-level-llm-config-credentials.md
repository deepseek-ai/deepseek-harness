# Agent Note: request-level LLM configuration and the credential seam

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-request-level-llm-config-credentials.zh.md)

> Scope: the first production consumers of `ctx.settings` (the two LLM adapter plugins), the new `packages/credentials/` capability family, and the `packages/util/atomic-write` extraction. The follow-up wire surface (`settings.*`/`credentials.*` RPC, secret-role masking, the web settings form) is separate work outside this note's scope.

## Problem

The [settings seam](2026-07-28-user-settings-seam.md) shipped without a production consumer, and the LLM adapters were the motivating one: both froze `apiKey`/`baseURL`/catalog into adapter instances at plugin load, so a changed key or endpoint needed a process restart, and a missing key failed plugin load — the worst possible first-run posture for a personal config page ("store a key, then restart"). Secrets were also headed the wrong way: the natural move (put `apiKey` in the settings document) would have forced masking, server-side backfill on `replace`, and dotfiles-sync warnings, a mitigation stack for a problem peer products simply do not have — Codex (`env_key` + auth.json), Reasonix (`api_key_env` + home `.env`), OpenCode/Pi (`auth.json`), Claude Code (`apiKeyHelper`) all keep secrets out of configuration files.

## Decision

**Per-request resolution, not fiber rebuilds.** The adapters take an options thunk (and a per-stream credential resolver) instead of frozen construction facts, resolving once per operation — the Pi pattern, with its tested semantics: two requests straddling a change see two configurations, one request resolves exactly once, and an in-flight stream keeps the facts it started with. This deletes the entire swap machinery a rebuild design needs (`DUPLICATE_ADAPTER` ordering, `NO_ADAPTER` windows, a deferred-activation state machine) and makes a missing key a *request-time* actionable failure (`MISSING_CREDENTIAL` naming every entry point) while the route stays registered and the catalog stays browsable. The one registration-captured fact — the retry policy the `ctx.llm` registry snapshots at `registerAdapter` (plus pi-ai's route *set*) — re-registers the same adapter instance in one synchronous section when it changes.

**Secrets are references, values live behind `ctx.credentials`.** Configuration (both planes) carries `apiKeyEnv: DEEPSEEK_API_KEY`; the three-package credential seam resolves it per operation. `credentials-local` layers the live process environment (read-only, wins — a launch-time override is operator intent and must be *visibly* read-only, so shadowed writes reject instead of appearing to succeed) over the provider-managed document (writable, wholesale snapshot replacement on reload so a deleted entry never lingers — the Claude Code additive-reapply lesson). That document was `$DSH_HOME/.env` in dotenv form; the [credentials document split](2026-08-04-credentials-yaml-and-user-environment-layer.md) later moved it to `$DSH_HOME/.credentials.yaml` and freed the old path to become the user's environment layer. Adapters resolve the reference through the seam, or — only without a mounted seam — through the environment layers.

**Per-plugin namespaces, schema ≡ `Config`.** Each adapter registers its own namespace (`llm-deepseek`, `llm-pi-ai`) with its plugin `Config` schema and its `cordis.yml` entry as the composition `base` — a settings section is the same YAML shape as the entry config, and `resolveAdapterOptions`/`resolveProfiles` stay the one explicit resolve step for both. A live snapshot failing a beyond-schema bound keeps the last good facts (the seam's last-good philosophy extended one level up); the entry config itself still fails load. pi-ai's `providers` became a dict keyed by route so base and user layers merge per provider and the route set is structural; the array shape fails loud with migration directions, and an empty dict is the valid dormant posture — a composition ships the adapter bare and every route stays a user-plane decision.

## Alternatives considered

- **A bridge plugin (`dsh-llm-models`) owning one unified `models` dict** — with per-plugin namespaces there is nothing left to bridge, and the adapter-mapping rules it needed were pure invented indirection.
- **Secrets in settings.yaml under `role('secret')` masking** — deleting the problem (references) beats mitigating it (mask + backfill + sync warnings); the coding-agent cohort is unanimous.
- **Registry-level live retry policy** — making `providerRetryPolicy` re-read per call would silently change the `ctx.llm` capture contract every registration relies on; re-registering the route in place keeps that contract and stays observable.

## Consequences

Onboarding is restart-free end to end (pinned by the `missing-credential` headless snapshot and the credentials-rotation composition tests): boot keyless, browse the catalog, store the key, prompt again. The demos mount `settings-file` + `credentials-local` by default and inline no `!!js` key plumbing. `runLoaderSmoke` gained `expectedExitCode` so a designed failure surface can be pinned rather than masked. Deferred: the wire/UI surface must redact `role('secret')` fields before any RPC exposes `describe()`, settings-layer arrays still replace wholesale (the deepseek `models` list), and a settings section cannot remove a composition-provided pi-ai route (only override or extend). A later decision reworked where the store lives and who may read it, made one request resolve one configuration generation, and made route replacement atomic ([credential boundaries note](2026-07-30-credential-boundaries-and-atomic-registration.md)).
