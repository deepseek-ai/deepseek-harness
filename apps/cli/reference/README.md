# `dsh` CLI behavior reference

English | [中文](README.zh.md)

This reference defines the profile, web-alias, plugin-management, and config-dump command modes. Argv is parsed once through [`src/args.ts`](../src/args.ts), and [`src/bin.ts`](../src/bin.ts) dynamically imports only the selected runner.

## Profile boot

`dsh --profile <name>` boots the profile at `$DSH_HOME/profiles/<name>`. The effective tree is composed over an empty root by applying, in order: each bundle patch named in the profile manifest's `dsh.profile.bundles` list, the profile's own `cordis.patch.yml`, the home-level `$DSH_HOME/cordis.patch.yml` (machine-local preferences shared by every profile, so it outranks the per-profile layer), and each `--patch <path>` overlay in argv order. Later layers win per row; a patch replaces the targeted row's complete `config` value rather than deep-merging keys, and may insert new rows. `dsh.profile.patchReload` selects `live` patch-file watching or `startup` one-time loading; omission defaults a custom profile to `live`. A parse, schema, resolution, or plugin boot failure is reported and exits nonzero. SIGINT and SIGTERM dispose the mounted root before exit.

Bundle names resolve from the dsh installation first, then from the profile directory. In-box bundles (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`, `@deepseek-ai/dsh-sdk-app`, `@deepseek-ai/dsh-sdk-minimal`, `@deepseek-ai/dsh-acp-app`) therefore always come from the same installation as the running `dsh`; out-of-tree bundles come from the profile's pnpm-managed `node_modules`. A bare plugin `name` in any patch row resolves through the profile directory's Node parent walk, which reaches the maintained installation fallback `$DSH_HOME/profiles/node_modules`. Plain Node installations place one healed symlink there per dependency-closure package. A pkg executable instead places a real ESM proxy that mirrors explicit exports and re-exports the virtual package URL, because operating-system symlinks cannot enter pkg's `/snapshot` filesystem. Every launch also links packages carried only by selected external bundles through a dsh-owned directory into the current profile's `node_modules`; existing pnpm entries win, and each profile owns its links independently.

The `web`, `headless`, `sdk`, `sdk-minimal`, and `acp` profiles auto-initialize from shipped templates on first use (`web`: base + web-app with live patches; `headless`: base + headless with startup-only patches; `sdk`: base + sdk-app with startup-only patches; `sdk-minimal`: its standalone bundle with startup-only patches; `acp`: base + acp-app with startup-only patches). Any other missing profile fails loud with a hint to run `dsh plugin --profile <name> add <package>`.

### App arguments

The launcher's flags come first and end at the first token it does not recognize; everything from there on is handed to the booted profile verbatim through `ctx.cmdlineArgs`, where any injected app plugin may parse it ([`dsh-cmdline`](../../../packages/boot/cmdline/README.md)). `dsh --profile web --port 8080` therefore reaches the web app's `--port`, `dsh --profile web --help` prints that app's help and boots nothing, and `dsh --help` (no profile to hand it to) prints the launcher's own. `-V`/`--version` prints the launcher's version when it appears before the app-argument boundary.

A composition mounts once. An ordinary plugin injects `cmdlineArgs`, parses this app's arguments, and provides what it resolved as a service; each row configured from flags injects that service, and Loader waits for it before evaluating the row's config (`port: !!js ctx.webStartup.port ?? 3080`). A flag therefore beats the value written beside it. This precedence requires the row to retain that expression; a user patch that replaces the whole `config` with literals removes the runtime read. Help and rejected arguments request exit — nonzero for a rejection, 0 for help — without activating rows that depend on the provider's service. In a `patchReload: live` profile, a patch-file edit re-evaluates expressions against services that are still up, so it cannot reset a served port.

Launcher flags must come before app arguments, and the launcher's parser consumes one `--`: an app argument that must arrive as a literal `--` needs `-- --`. A first app argument equal to `web` or `plugin` selects that subcommand instead. `ctx.cmdlineArgs.get()` is a shared immutable read: multiple plugins may parse the same snapshot, while a profile with no reader ignores its app arguments.

The shipped apps own these command lines:

| Profile | Arguments |
|---|---|
| `web` | `--host`, `--port`, repeatable `--trusted-host`, `--no-open` |
| `headless` | the task text, as the positional argument |
| `sdk` | no options; stdio carries the JSON-RPC protocol |
| `sdk-minimal` | no options; stdio carries the same JSON-RPC protocol |
| `acp` | no options; stdio carries Agent Client Protocol |

A one-shot task (`dsh --profile headless "run the tests"`) creates one fresh persisted Agent through the core registry, submits the task, waits for quiescence, and flushes the Session before deriving the last non-empty assistant text and final `turn/end` reason from its durable interval. It streams non-empty provider reasoning deltas to stderr under a `dsh: reasoning:` heading, prints only the final text on stdout, and exits 0 for `completed`, else 1; a successful response with no reasoning leaves stderr empty. An invocation with no task is a usage error from that app. The shipped headless profile mounts no browser Connection, HTTP server, Web runtime, or browser client, and opens no listening port.

Inspect the composed tree without booting it:

```sh
dsh --profile web --dump-default-config
dsh --profile web --patch ./extra.yml --dump-config
```

`--dump-default-config` prints only the bundle layers; `--dump-config` adds the profile's `cordis.patch.yml`, the home-level `$DSH_HOME/cordis.patch.yml`, and `--patch` overlays. Both print comments naming the file that supplied each row and every overlay that changed it; `!!js` expressions remain unevaluated, relative plugin names in inserted rows resolve beside their patch file, and unmatched patch targets are reported on stderr. A dump initializes missing profile files but does not prepare the runtime module fallback under `$DSH_HOME/profiles/node_modules`. It never runs app command-line providers, so it shows the composed tree before any app argument is resolved and rejects an invocation that carries app arguments.

## Plugin management

`dsh plugin --profile <name> <args...>` initializes the profile when missing (shipped template, or `@deepseek-ai/dsh-base` alone for other names), then forwards `<args...>` to `pnpm` with the profile directory as working directory — `add`, `remove`, `why`, `update`, and every other pnpm verb work unchanged; pnpm must be on PATH. Relative path specs (`.`, `../plugin`, and their `file:`/`link:` forms) are anchored to the invoking directory first, so `add .` from a plugin checkout installs that checkout, not the profile. After every successful run, `dsh.profile.bundles` is reconciled against the installed state: each dependency resolving to a package whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` joins the layer stack (so an `update` that gains the declaration activates it), a bundle-less dependency stays plain with a one-time warning, and a removed dependency leaves the stack.

The Codex and Claude Code subagent providers are separate optional Bundles. Add either package, both in one command, or remove either package independently:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
```

The successful pnpm operation changes the Profile manifest and Bundle list on disk; a running Profile keeps the Bundle set from its current start. Restart that Profile after adding, removing, or updating a Bundle. This startup boundary applies to Bundle membership, while ordinary edits to the Profile or home `cordis.patch.yml` take effect through hot reload. On the next start, each installed Bundle registers only its dormant Host provider; a copied Preset must separately enable the matching tool row for new Agents. The [Codex provider README](../../../packages/subagent/subagent-codex/README.md) and [Claude Code provider README](../../../packages/subagent/subagent-claude-code/README.md) own executable, authentication, payload, and failure details; the [base Bundle reference](../../../packages/bundle/base/README.md) owns the default dependency closure.

```sh
dsh plugin --profile tui add github:deepseek-harness/turtle-ui
dsh plugin --profile tui remove turtle-ui
dsh --profile tui
```

Git-hosted plugins that ship sources build during install through their `prepare` script, which pnpm ≥10 blocks until the consumer allows it: the first `add` fails with pnpm's `allowBuilds` hint (and a dsh pointer at the profile's `pnpm-workspace.yaml`); copy the printed key there and re-run. Installing a built tarball or a local checkout needs no allowance.

## Web alias

`dsh web` is a hardcoded alias for `--profile web`; the flags after it belong to the web app, whose ordinary bundle provider parses them. `--host` and `--port` override the composed values of the rows that carry them, repeatable `--trusted-host` contributes invocation authorities through `ctx.webRuntime.trustedHosts` (a deployment expression concatenates its own authorities), and `--no-open` disables the default-browser handoff for this invocation. The client-plugin HMR receiver is always mounted and stays idle until a separate `pnpm run dev:web` watcher rebuilds client bundles.

```sh
dsh web
dsh web --no-open
dsh web --patch ./extra.cordis.yml
dsh web --dump-config
dsh web --help
```

The production Web runner needs built package and frontend artifacts (`pnpm run build`). It serves `http://127.0.0.1:3080` by default and, for a local launch, opens that canonical host URL only after the complete Loader tree settles. A non-empty inherited `SSH_CONNECTION` or `SSH_TTY` suppresses the browser handoff because the SSH client or editor owns the local forwarded address; the host URL is still printed. The CLI intentionally does not support `--host 0.0.0.0` and exits with a usage error. Immediately before a local handoff it prints `dsh web: opening the default browser; pass --no-open to disable`; if the operating-system handoff fails, a diagnostic on stderr states the reason, leaves the server running, and names the URL for manual use. `--trusted-host` adds named authorities accepted by the `/api` browser-trust fence.

Process shutdown gives the plugin tree up to five seconds to dispose. The first `SIGINT`/`SIGTERM` starts that graceful drain — `SIGTERM` is a supervisor's ordinary stop request and exits 0 on every surface, `SIGINT` reports 130; a second signal forces immediate exit. If one-shot normal completion is already stuck in disposal, the first `Ctrl+C` is the escalation and exits immediately instead of being swallowed.

The base-backed modes treat the invoking directory as the default workspace root, load applicable `AGENTS.md` or `CLAUDE.md` instructions with a 65,536-byte render budget, and use an in-memory SQLite session content index. The standalone `sdk-minimal` profile uses the invoking directory as its local filesystem and sandbox-policy root but intentionally omits instruction discovery and SQLite. A `patchReload: live` profile watches valid edits of both `cordis.patch.yml` layers (profile and home) and reapplies them transactionally; a `startup` profile applies them once. A one-shot surface exits through its bounded shutdown, which disposes any live watchers.

New sessions in base-backed profiles default to the `workspace-write` permission preset. Bash and filesystem mutations are restricted to the session workspace and platform temporary roots; reads and network access are not confined, while process visibility depends on the selected sandbox backend — bwrap runs commands in a private PID namespace that hides host processes, and Landlock and Seatbelt leave host process visibility unchanged. `DSH_PERMISSION_MODE` changes the process fallback. Stored General-settings permissions affect later Web sessions, not an already-open one. The standalone `sdk-minimal` tree instead pins `danger-full-access` and mounts no approval or permission-settings service.

`DSH_TOOLS_MODE` selects `native`, `ptc`, or `both` for the process; another value fails at boot. The shipped `minimal` agent preset keeps that deployment presentation, fixes the complete system prompt to `You are a helpful software engineer assistant.`, and composes only persistent `bash` plus `str_replace_editor`. Select 极简模式 when creating a Web session; every other prompt section and model-facing plugin remains absent from that agent while the shared browser, workspace, persistence, sandbox, and permission host stays in place.

## Shared deployment behavior

The base bundle mounts the native DeepSeek adapter, settings and credential providers, stable `web_search` and `web_fetch`, the public-only HTTP fetch provider, opt-in DeepSeek session-log upload, and feedback-gated OTel upload for all users. Provider credentials resolve from the inherited environment, `$DSH_HOME/.credentials.yaml`, the invoking directory's `.env`, then `$DSH_HOME/.env`; the managed document is never materialized into `process.env`, while both `.env` files are ordinary launch environment layers. Search uses `DEEPSEEK_API_KEY` and accepts `DEEPSEEK_SEARCH_BASE_URL`. Enabled fetch calls run in every sandbox and approval mode without per-call confirmation; the provider rejects non-public destinations before connecting. The Web app disables the base tool row and exposes the same tools through its `cordis`, `ptc`, and `standard` agent presets.

Feedback is recorded in the Session log without starting model work. Enable the [DeepSeek session-log contributor](../../../packages/session/session-log-deepseek/README.md) to send complete unaccepted log suffixes with subsequent DeepSeek requests, including configured gateways. [OTel session upload](../../../packages/session/session-telemetry-otel/README.md) applies to all users and providers, including `deepseek-official`, without requiring a request header. The base defaults to `FEEDBACK_ONLY`: new own text feedback, message ratings, edits, and withdrawals release the complete canonical prefix through that event, including stored context; later records wait for the next explicit feedback. Inherited parent feedback does not authorize a fork. Requests, restoration, mount, and HMR do not trigger capture. SDK batching may finish an authorized upload without further interaction or model work. `DSH_TELEMETRY_MODE=DISABLED` disables OTel delivery; `FULL` is rejected, and any non-empty `DSH_TELEMETRY_DISABLED` disables its row. `DSH_TELEMETRY_OTLP_URL` selects the collector. Handoff is best-effort, not collector acceptance; no durable outbox or retry guarantee is provided. These OTel settings do not enable or disable the DeepSeek contribution. Neither path changes model input, but exports can include message text, tool arguments and results, and workspace paths.

Install external plugin bundles through `dsh plugin --profile <name> add <package-or-git-spec>`. The installed package owns its dependencies and contributes its declared `cordis.patch.yml` layer. The CLI also ships `@deepseek-ai/dsh-mcp-client` as a dependency for patch layers, but no MCP server is enabled by default because each server command is trusted executable code outside the agent sandbox.

<a id="source-execution"></a>
## Source execution

From the repository root, run `pnpm run build` separately after a fresh checkout and whenever artifacts need updating, then use `pnpm dsh <args...>`. The `package.json` script launches `apps/cli/src/bin.ts` with `node --import tsx/esm` without building and forwards every argument. Missing Typert host artifacts fail profile boot through module-resolution errors without a build instruction. Once those host artifacts exist, missing frontend or client-plugin bundles fail at startup with an instruction to run `pnpm run build`. The launcher does not check freshness, so existing stale bundles can run older browser code until rebuilt. The process inherits the launch environment, and `runProfile` resolves the outbound proxy from that snapshot before any entry mounts, so `HTTP_PROXY`/`HTTPS_PROXY` (and a proxy declared in a `.env` layer) apply without any further flag. The installed form launches the built `apps/cli/lib/bin.js` without rebuilding the repository.
