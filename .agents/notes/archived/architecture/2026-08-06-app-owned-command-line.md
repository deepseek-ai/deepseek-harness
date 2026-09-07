# Agent Note: Apps own their command line through `ctx.cmdlineArgs`

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-app-owned-command-line.zh.md)

## Problem

After profiles, compositions were installable but their command lines were not. `apps/cli` still declared the Web flag family (`--host`, `--port`, `--dev`, `--workspace-root`, `--trusted-host`) and the one-shot task positional, then derived patches for row ids it hardcoded (`webserver`, `api-gateway`, `connection`, `web-runtime`). An out-of-tree app such as [turtle-ui](https://github.com/deepseek-harness/turtle-ui) could contribute rows but had no way to accept a flag: `dsh --profile tui --resume <session>` had nowhere to be parsed, and `dsh --profile web --help` printed the launcher's help rather than the web app's.

## Decision

The launcher parses only what it owns — `--profile`, `--patch`, the config dumps — and hands **everything after its own flags** to the booted tree verbatim. The split is positional: the first token the launcher does not recognize starts the app's arguments (commander's `passThroughOptions` + `allowUnknownOption` + `helpOption(false)`). A bare `dsh -h`, which has no app to hand the flag to, still prints the launcher's own help.

The new `@deepseek-ai/dsh-cmdline` package owns the handoff. A launcher calls `provideCmdline(ctx, host)` before any entry mounts, providing `ctx.cmdlineArgs` (whose whole interface is `get(): readonly string[]`) and `ctx.appExit`. Any ordinary app plugin may inject `cmdlineArgs`, call `parseCmdline(ctx, program)` with its own commander program, and provide the resolved value as an app-owned service from the program's action. Its Loader row carries no launcher marker or special kind, and the launcher does not inspect the composition for an owner. Multiple plugins may read the same immutable snapshot; a profile with no reader ignores its app arguments. Rows configured from a provider inject its service and read direct lazy config expressions (`port: !!js ctx.webStartup.port ?? 3080`), so a flag beats the value written beside it and nothing is written back into any row.

The boot mounts the composition once. Cordis holds each row until its injections are active; Loader then interpolates that row's `!!js` against the injection-ready plugin context immediately before activation. Include keeps nested row expressions raw until their target row reaches this point. `--help` leaves the provider's service absent, so dependent rows never activate, and a live patch reload interpolates again against the service that remains active, so a served port cannot be silently reset.

The shipped apps moved their flags into their bundles: `dsh-web-app` owns the Web family, and `dsh-headless` owns the task positional and rejects a missing task as a usage error. `apps/cli/src/web.ts` is gone; `runProfile` no longer knows any flag-target row id. Out of tree, turtle-ui gained `--resume <session>` / `--session <id>` the same way, which is the design's real validation: an installed plugin added a flag with no launcher change.

Two further consequences. Loader mounts sibling rows concurrently, so one row can activate while another still mounts or while the whole boot is rolling back; the Web bundle therefore publishes its URL only after its own Loader tree settles. The Web bundle's runtime plugin owns the harness-source prompt section too, so `dsh web` and `dsh --profile web` boot identically without Web-specific launcher setup.

## Why Loader owns the ordering

Three framework facts shape the mechanism:

- **A profile's rows arrive inside the root include's `patches` option.** Include declares the `EntryGroup.key` tree-carrier marker (as Group does), so Loader keeps its config — entry and patch lists, including Include's own `path` — literal instead of recursively evaluating nested `!!js` nodes in the Include context; each expression resolves in its target row's fiber.
- **Cordis activates a fiber only after all declared injections are active.** Immediately before each activation, Cordis runs the `internal/config` waterfall against the fiber's own context; Loader's listener interpolates the raw config after Cordis snapshots its injected services.
- **Provider replacement and HMR must preserve the same contract.** Fiber reactivation re-runs the waterfall, HMR carries the raw config to the replacement fiber, and a pending row accepts option changes without prematurely evaluating expressions against absent services.

This leaves dependency ordering in Cordis activation and Loader interpolation, which own it. Rows keep their `inject` and config, Loader mounts the composition once, and the launcher only provides argv and process-lifecycle services.

## Alternatives considered

- **Writing the resolved values into each row** (a config update per row, plus a patch layer handed back to the launcher so a reload could not undo it): it worked, but it meant patches travelling from an app to the launcher and back, two mechanisms for one fact, and a recycle whose correctness depended on Loader restart internals. The maintainer rejected the round trip; the service the rows read replaced all of it.
- **Releasing rows by clearing their `inject`**: it worked in isolation and failed on the real web tree, because clearing `inject` is exactly what loses the plugin's static injections. The failure is silent until a plugin reads a service it declared.
- **Launcher-managed two-pass mounting**: it can make a provider active before readers are applied, but duplicates the composition, makes ordering a launcher concern, and conceals the Loader defect that nested expressions were evaluated in the include context rather than the target row's injected context.
- **The launcher running each bundle's command function before boot** (no Cordis involvement): strictly earlier than "boot, then help", but it makes app startup a second plugin protocol outside the tree. An ordinary `cmdlineArgs`-injected provider keeps one protocol and remains dumpable and patchable.
- **A launcher-enforced command-line owner**: rejecting zero or multiple readers would arbitrate overlaps such as `-h`, but `get()` is an immutable read and normal composition may need several app-owned services. Plugins therefore share the snapshot and own any parser interaction through ordinary composition.
- **`instanceof CommanderError`**: an out-of-tree plugin brings its own commander copy, so the class identity differs and a printed `--help` was rethrown as a fatal load failure. Commander's control-flow errors are detected structurally instead.

## Consequences

- An app's flags, help text, and usage errors live with the rows they configure; adding a flag to an installed plugin needs no launcher change.
- The launcher recognizes no app row at all: the telemetry row remains its only composition probe (for the environment switch), SIGTERM exits 0 on every surface, every boot watches its user patch layers, and the one-shot runner exits through `ctx.appExit` like any other app.
- `--help` leaves every row that depends on the provider's service pending and requests bounded exit; unrelated rows may activate concurrently before teardown.
- An app-owned service has no statically declared provider: a bundle shipping consumer rows without that provider fails at settlement with pending entries naming the service, not at load.
- A user patch that replaces a row's whole `config` drops its expressions, and with them the flag's precedence for that row.
- Launcher flags must precede app arguments; a first app argument equal to `web` or `plugin` selects that subcommand instead, `-V`/`--version` remains launcher-owned before that boundary, and the launcher's parser consumes one `--`, so a literal `--` for the app needs `-- --`.
- `--dump-config` never runs app command-line providers, so it prints the composition before any app argument is resolved and rejects an invocation that carries app arguments.
