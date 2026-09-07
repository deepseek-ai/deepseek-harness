---
description: "App-owned command lines for dsh app bins: your app parses its own flags, --help, and exit behavior from the launcher's remaining arguments."
kind: "package-library"
---

# @deepseek-ai/dsh-cmdline

English | [中文](README.zh.md)

## Summary

`dsh-cmdline` lets your app own its command line: the launcher keeps only its own flags (`--profile`, `--patch`, the config dumps) and passes everything after them to your app verbatim, so your app decides its flags, its `--help` text, and its parse errors. Values you parse from those arguments win over any default written in the config, without writing anything back. Your app also gets a bounded way to ask for process exit, wired to the launcher's shutdown. Use it when you write an app bin that accepts its own flags; it adds no prompt, schema, or model-facing surface of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Your app reads the invocation's inner arguments at startup, and any number of its plugins can use them. The common path: a startup plugin reads the arguments, parses them, and publishes the parsed values; other rows configure themselves from those values.

### The launcher values

The launcher makes three things available to your app:

- `ctx.cmdlineArgs` — the inner arguments of your invocation. Reading them returns an immutable snapshot and never consumes or changes them: `dsh --profile tui --resume abc` gives your app `['--resume', 'abc']`.
- `ctx.appExit` — a way to ask the process to exit once the tree has shut down, wired to the launcher's shutdown controller.
- `ctx.appReady` — the successful-startup signal, committed only after the Loader tree and launcher-owned setup succeed.

An app launched with no arguments sees an empty list — that is the honest answer, not a missing value.

`exitOnStdinEnd(ctx, label)` binds a successfully started stdio application's EOF to `ctx.appExit(0)`. It never reads or resumes stdin, so a protocol transport receives bytes buffered before it mounts; startup rejection wins over a racing EOF, and the owning fiber removes both pending listeners.

### Parsing your flags

You bring your own commander program: declare your flags and your actions, and the package runs it against the inner arguments. Your action is the only place validation happens, and it publishes whatever your rows need. The plugin's Loader row carries no special marker:

```yaml
- id: web-startup
  name: '@deepseek-ai/dsh-web-app/startup'
```

Rows configured from the parsed values inject the published service and read it directly in their config:

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

The outcomes: `dsh --profile web --port 8080` starts the server on port 8080 even when the config says 3080, because the flag wins. `--help` prints your app's help and exits 0 without starting anything; a rejected value (for example a non-numeric port) prints your error and exits nonzero, and no row that depends on the parsed values ever starts.

### How flags beat config values

The value written beside a `!!js` expression is the fallback: the flag wins when present, the written value is used otherwise. Resolution happens once at startup, after your parser ran, so a flag is never silently reset by a later config reload.

### Reading the same arguments from several plugins

Any number of plugins can read the same arguments — reading never consumes them — and each can parse what it needs and publish its own values. The launcher does not decide who owns the command line: an app with no reader ignores its arguments.

Apps built outside this repository behave the same way: their `--help` prints and exits instead of crashing, even though they carry their own commander copy.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the outcomes above are realized and points at the code that realizes them; everything here is developer-facing and not needed to use the package.

### Design notes

- **Launcher facts, not config.** `cmdlineArgs` and `appExit` are provided on the host context before the tree mounts; they are not Loader rows, so no composition owns or overrides them.
- **Positional split.** The launcher recognizes no app row: the first token after its own flags starts the app's arguments, so the app owns its flag family, its `--help` text, and its parse errors.
- **Structural error detection.** `isCommanderError` reads commander's error code prefix instead of using `instanceof`, because an out-of-tree plugin brings its own commander copy whose `CommanderError` identity differs; `configureExitAndOutput` walks every subcommand because commander copies exit and output settings only at registration.
- **Injectable output streams.** `internals` holds the output streams so tests can capture commander's text without touching the process.

### Parsing contract

The parse path is one small family with two owners: `provideCmdline` freezes the host arguments and provides `cmdlineArgs` and `appExit` before any tree entry mounts, and `parseCmdline` runs your commander program against the immutable arguments, routing every command's help, version, and error output through the launcher. A rejected value, `--help`, or `--version` prints commander's text and requests `ctx.appExit` without publishing anything, so dependent rows never activate; Loader defers each row's `!!js` interpolation until its declared injections are active. Per-export contracts live in the code, not this README — see [`src/index.ts`](src/index.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `CmdlineArgs`/`AppExit` types, `provideCmdline`, `parseCmdline`, commander exit/output routing |
| — | No runtime invariant companion is published; `cmdlineArgs` is an immutable launcher fact that any number of ordinary plugins may read. App-owned providers and consumers use normal Cordis service injection, whose missing dependencies are already reported by Loader settlement. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the handoff mechanism to the apps that consume it.

- [dsh-app-boot](../app-boot/README.md) — the boot sequence that provides these launcher values.
- [dsh-web-app bundle](../../bundle/web-app/README.md) — an app that owns the Web flag family through this package.
- [dsh-headless bundle](../../bundle/headless/README.md) — the one-shot runner that reads its task from the command line.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package resolves the process command line before any session exists; configured rows own every model-visible consequence.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe where app-owned command lines are a poor fit or need special care. They are current package constraints, not a task backlog.

- **Launcher flags must precede app arguments** — the split is positional: the first token the launcher does not recognize starts the inner arguments, so `--patch` placed after an app flag belongs to the app. The launcher's parser consumes one `--`, so an app argument that must survive as a literal `--` needs `-- --`.
- **An app-owned service has no statically declared provider** — consumer rows name it through ordinary injection; a bundle that omits its provider fails at settlement with pending entries naming the service rather than at load.
- **A user patch that replaces a row's whole `config` drops its expressions** — a flag beats the value written beside it, not a literal a user wrote in place of the expression; keeping the expression is what keeps the flag winning.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Open: parser surface

`parseCmdline` is a commander adapter, not a command-line framework: help, version, and error output follow commander's formatting, and the exit/output routing assumes commander's control-flow model. A different parser would need its own routing and error handling; nothing in the `cmdlineArgs` service contract depends on commander.

</details>
