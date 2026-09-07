# Agent Note: One ordering for configuration sources, and what a discovered file may not decide

Status: implemented

English | [中文](2026-08-04-configuration-source-ownership.zh.md)

## Problem

`$DSH_HOME/.env` had just [become an ordinary environment layer](../../archived/architecture/2026-08-04-credentials-yaml-and-user-environment-layer.md), which left the harness resolving user-facing values from a flattened `process.env` that could no longer say where a value came from. Three consequences followed.

A key stored through the web page stayed shadowed by an older key in the user's own `.env`, because the credential provider compared "the environment" against its file and the environment now included that file. The migration dead end the split was supposed to remove had simply moved.

An endpoint could be redirected by the project. The invoking directory's `.env` is materialized like every other layer, and a base URL decides where a resolved API key is sent — so a `DEEPSEEK_BASE_URL` written into a workspace the model can edit would send the user's own credential, and the prompts carrying their code, to whatever host that file named. Nothing about the flattened view could distinguish that from the operator exporting the same variable.

And `!!js process.env.X` in the shipped composition made the same value reachable twice: once through the entry config and once through whatever ladder its consumer applied, with the winner decided by layer order rather than by what the value means.

## Decision

**One ordering for non-secret values.** Every configurable value that is not itself a credential resolves in the same order; the domains differ only in which tiers exist.

```text
explicit for this run     per-operation override, CLI argument
> user settings           settings.yaml
> composition             profile bundles, user patch layers, --patch overlays
> this launch's shell     inherited process environment
> discovered file         <invocation cwd>/.env, then $DSH_HOME/.env
> defaults                schema default, provider public default
```

Settings sit above composition because that is what the [settings seam](../../archived/architecture/2026-07-28-user-settings-seam.md) does: a plugin registers its cordis entry config as the `base` layer and the user's section layers over it, and the seam cannot tell a value a profile's bundles set from one its user patch layer or a `--patch` overlay set — all arrive as entry config. The product CLI has no lever above stored settings, so a deployment that must pin a field against a user's settings ships its own bin or loader tree, or mounts no settings provider at all. Composition still outranks the environment, so a stale `DEEPSEEK_BASE_URL` in a shell cannot rewrite a configured endpoint.

**Credentials keep a narrower, separate ordering**, and this note does not unify them:

```text
inherited process environment      (read-only, wins)
> $DSH_HOME/.credentials.yaml      (provider-managed, writable)
> <invocation cwd>/.env
> $DSH_HOME/.env
```

The launching environment wins because `DEEPSEEK_API_KEY=… dsh`, a CI secret, and a container `-e` are the one override an operator must be able to apply per run without editing machine state, and because it cannot be edited from inside it must be *visibly* read-only. Configuration is meant to carry only the *reference* — which name to resolve — and that name follows the non-secret ordering above.

**The project the harness is launched in is trusted, by default and without a prompt.** A checkout may carry its own endpoint, its own ordinary variables, and its own key; the key ranks below the managed store, so a key stored through the Models page is never displaced by one a checkout happens to contain. `LaunchEnvironmentSnapshot.getFrom(name, sources)` still searches only the layers a caller names, and omitting one is a refusal rather than a demotion — the mechanism exists for decisions where a layer must be unreachable; this decision includes the project layer.

**Trust does not extend to changing the harness itself.** `loadLayeredEnv` rejects, at load and before anything is materialized, any `.env` that sets a variable governing how a process launches (`PATH`, `SHELL`, `NODE_OPTIONS`, `LD_PRELOAD`), which ambient program handles an operation (`EDITOR`, `PAGER`, `BROWSER`), what code a runtime executes before the program it was asked to run (`BASH_ENV`, `PERL5OPT`, `PYTHONSTARTUP`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`, the Git hook commands), where model-visible instructions load from (the whole `DSH_*` namespace, `HOME`, `XDG_*`), or how the network is reached and trusted (proxy and CA variables). Matching is case-insensitive, so `https_proxy` is not a bypass. One exemption, recorded in [the proxy policy note](2026-08-27-outbound-proxy-policy.md): the four proxy names are accepted from `$DSH_HOME/.env`, which no `.env` can relocate, and still refused from the invoking directory's file.

The line is that these take effect with no user action, before any turn, outside the permission policy and the sandbox. `DSH_PERMISSION_MODE` would switch off the approvals that make trusting a project meaningful at all, and `BASH_ENV` runs a file of the project's choosing on every single `bash -c` the bash tool issues — the project's code running under the agent's policy is the deal; the project rewriting that policy is not. Enumerating these is a losing game one variable at a time, which is why the whole `DSH_*` namespace is denied rather than an audited subset, and why the list is organised by what a variable *does* rather than by which runtime owns it. There is no opt-out: an escape hatch would have to be readable from somewhere, and anything a discovered file could set is the hole itself.

**`packages/util/launch-environment` owns the snapshot**, deliberately as a utility rather than a three-package capability seam. The snapshot is frozen before Cordis starts and injected once by the launcher, so there is no runtime implementation to swap; consumers need types and pure functions, which a `util/` package gives them without depending on a UI package. `launchEnvironmentOf(ctx)` returns the launcher's snapshot, or the inherited environment as the only layer — an SDK host or bare `cordis.yml` discovered no files, so its single layer really is what it was launched with, and the same trusted lookups keep working there unchanged.

**`verify-config-source-ownership`** is a narrow tripwire for the ordinary single-line form of an `apiKey`/`baseURL`/`headers` environment inline in shipped Cordis configuration. Removing those inlines is what makes the deployment tier meaningful — with the shipped tree silent on `baseURL`, a present value means a human or deployment set it. Adapters own actual resolution; the gate makes no repository-wide claim about `process.env` access.

## Consequences

- The web credential form now takes effect against an older key in the user's `.env`; only a key exported in the launching shell still makes it read-only, and the diagnostic says so.
- A `.env` holding `DSH_*`, `PATH`, `BROWSER`, or — in the invoking directory — a proxy variable fails the launch instead of being applied. Developers keeping switches in a repository `.env` move them to their shell — a deliberate, loud break.
- Composition is no longer overridable by a stale shell endpoint. It is still overridable by a user's stored `settings.yaml`, which is the settings seam's layering and not something this note changes; the product CLI offers no flag above it, so a deployment that must win against stored settings owns its own bin or loader tree.
- Not solved: the layers are still materialized into `process.env`, so ordinary project variables continue to reach child processes under the subprocess scrub. Bootstrap variables cannot come from a file at all; the environment package records the remaining subprocess reach as a limitation.
- Exa and Perplexity still capture their key at load time rather than through the credential seam. They no longer read raw `process.env` — they resolve through the trusted layers — but converting them to per-request credential resolution is separate work.

## Alternatives considered

**Unify credentials into the non-secret ordering, by who authored each source.** Attempted and abandoned: it reads well, but the settings seam already fixes composition *below* the user section, so "authored by deployment" is not a tier the seam can express — and moving `.credentials.yaml` above the launching environment would take away the one override CI, containers, and a per-run `DEEPSEEK_API_KEY=…` depend on. Two orderings that each explain their precedence beat one that describes neither accurately.

**Withhold routing and credentials from the invoking project until it is explicitly trusted.** Rejected as the product's stance: a checkout is trusted by default, with no prompt and no stored trust record. The residual is real and worth naming — cloning a repository that carries a `.env` naming another endpoint or key routes that session through it — and a later project-trust gate is where that gets addressed, not a rule that makes the common case require ceremony.

**Audit an allowlist of `DSH_*` variables a `.env` may set.** Rejected: the list would have to be re-audited on every new switch, and the failure mode of forgetting is silent. Denying the namespace fails safe.

**Rank a bootstrap variable below the process layer instead of rejecting it.** Rejected: `PATH` and `NODE_OPTIONS` have no meaningful "loser" behavior — a user who put one in a `.env` believes it applies, and silently ignoring it is the "my setting has no effect" failure this decision exists to remove.

**Build the snapshot as a three-package capability seam (`environment` / `environment-local` / consumers).** Rejected as premature: the producer runs before Cordis exists and there is no second implementation to select. The repository rule is to not split preemptively.

**Stop materializing the layers into `process.env`.** Deferred, not rejected: it would keep project variables out of child processes entirely, but it silently breaks any user patch layer that reads `!!js process.env.X`. The snapshot is already the authority for everything the harness resolves, so this can land later without changing any ladder.
