---
description: "Run a third-party CLI that keeps the user's account from a CLI app plugin: bounded commands on the private Shell PATH and one Host-owned account operation at a time for the Plugins page."
kind: "package-library"
---

# @deepseek-ai/dsh-cli-account

English | [中文](README.zh.md)

## Summary

CLI app plugins such as Feishu and WeCom use this library to run their vendor CLI and to check, connect, and cancel the account their Plugins page shows. `CliCommandExecutor` runs one command on the private Shell PATH with a deadline, an output limit, and line callbacks. `CliAccountRuntime` runs one account operation at a time, offers authorization links only on trusted hosts, cancels only in the phases the plugin declares, and streams the account view. Each plugin keeps its own commands, parsing, and account states.

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

### When to use it

Use it in the Host row of a plugin whose vendor CLI signs the user in and keeps the credentials, so DSH only starts commands, shows their results, and owns their processes. The plugin's Plugins page mirrors the view with [`@deepseek-ai/dsh-client-ui-cli-account`](../../client/ui-cli-account/README.md). A plugin that connects a hosted service over MCP uses the MCP manager instead, which owns OAuth itself.

### Entry point

A plugin subclasses the runtime, runs each command through its control, and serves the runtime's methods over its own Remote:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { CliAccountRuntime, CliCommandExecutor, exitFailure, type CliOperationControl } from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-subprocess'

declare const ctx: Context

class Account extends CliAccountRuntime<{ readonly state: 'unchecked' | 'out' | 'in' }, 'check', never> {
  protected async perform(_kind: 'check', control: CliOperationControl<never, 'status'>, signal: AbortSignal): Promise<void> {
    const result = await control.run('status', ['auth', 'status'], signal)
    if (result.exitCode !== 0) throw new Error('vendor-cli: auth status failed')
    this.publish({ state: result.stdout.trim() === 'authorized' ? 'in' : 'out' })
  }
}

const account = new Account({
  name: 'vendor', logger: ctx.logger, account: { state: 'unchecked' }, check: 'check', cancellable: [],
  authorizationHosts: ['vendor.example'], classify: exitFailure,
  cli: new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: 'vendor-cli', commandTimeoutMs: 30_000 }),
})
```

`account.start(kind)` returns the operation id and throws while another operation runs. `account.follow(signal)` yields the current `CliAccountView`, starting a check when no operation runs, then each changed view. `account.cancel(id)` stops the named operation only in a declared cancellable phase. `account.dispose()` cancels the active operation, waits for its process to exit, and disposes the executor. The contracts in [`src/runtime.ts`](src/runtime.ts) and [`src/executor.ts`](src/executor.ts) are authoritative.

### Commands, links, and failures

A command that does not wait for the user gets the plugin's `commandTimeoutMs`, including executable lookup; a command run with `awaitsUser` waits up to 10 minutes. The executor keeps at most 1 MiB of stdout and the last 4 KiB of stderr, both counted in UTF-8 bytes and the tail cut at a character boundary, and settles only after the process exits. `onLine` receives each line as the command writes it: `\n`, `\r\n`, and a lone `\r` each end a line, as in Node's `readline`, so a spinner the CLI redraws with `\r` after a link line does not hold the link back. The unterminated rest arrives at exit, and a line longer than its stream's limit is skipped whole rather than truncated. `offer(url)` accepts only an HTTPS URL without credentials on one of the plugin's `authorizationHosts` or their subdomains, and returns whether it accepted the link. A failed operation logs and returns only the plugin's classification of its last command, `{ command, exitCode }` plus allowlisted fields; exception messages and native output are neither logged nor returned, because they may contain credentials.

### Shared config

Plugins with no other fields use `CliAccountConfig` as their `Config`:

| Field | Default | Meaning |
|---|---|---|
| `binDir` | defined by the plugin | Absolute directory holding the CLI executable |
| `commandTimeoutMs` | `30000` | Deadline for a command that does not wait for the user, including executable lookup |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runtime owns the operation lifecycle and the plugin owns the meaning of each command. One active operation holds its abort controller, phase, and link; the runtime builds the view from them and notifies followers on every change, and a follower that reads late sees only the latest view. The executor prepares the private PATH environment for the subprocess runtime, resolves the program in it, and spawns with that environment, so the backend and the Shell use the same executable.

| File | Role |
|---|---|
| [`src/executor.ts`](src/executor.ts) | Bounded command execution and process ownership |
| [`src/runtime.ts`](src/runtime.ts) | One-at-a-time operations, cancellation, link filtering, failure classification, and the follow stream |
| [`src/types.ts`](src/types.ts) | The generic Remote view types |
| [`src/index.ts`](src/index.ts) | The entry module and the shared config fields |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this library and the CLI app plugins belong to.
- [CLI plugin page pieces](../../client/ui-cli-account/README.md) — the browser half that mirrors the view.
- [Shell environment](../../shell/shell-env/README.md) — private PATH contributions shared by backend subprocesses and Shell tools.
- [Subprocess](../../subprocess/subprocess/README.md) — the runtime that resolves and spawns the CLI.

-----

<a id="model-experience"></a>
## Model Experience

None, as the library registers nothing model-facing; each plugin owns the skills its CLI needs.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The 10-minute deadline for commands that wait for the user and the 1 MiB stdout limit are fixed; a CLI whose sign-in waits longer fails with a retryable result.
- Authorization hosts match their subdomains too; a plugin cannot restrict links to one exact host.
- `exitFailure` classifies by exit code alone; a plugin whose CLI reports structured errors writes its own allowlisting classifier.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
