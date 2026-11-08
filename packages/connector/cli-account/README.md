---
description: "Run a third-party CLI that keeps the user's account from a CLI app plugin: bounded commands by the CLI's absolute path, runtime context that gives the model that path, and one Host-owned account operation at a time for the Plugins page."
kind: "package-library"
---

# @deepseek-ai/dsh-cli-account

English | [中文](README.zh.md)

## Summary

CLI app plugins such as Feishu and WeCom use this library to run their vendor CLI and to check, connect, and cancel the account their Plugins page shows. `CliCommandExecutor` runs one command by the CLI's absolute path with a deadline, an output limit, and line callbacks, and `registerCliPathContext` gives the model the same path in runtime context. `CliAccountRuntime` runs one account operation at a time, offers authorization links only on trusted hosts, cancels only in the phases the plugin declares, and streams the account view. Each plugin keeps its own commands, parsing, and account states.

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

Use it in the Host row of a plugin whose vendor CLI signs the user in and keeps the credentials, so DSH only starts commands, shows their results, and owns their processes. The plugin shows the account on the Plugins page by registering the runtime as the account source with `ctx.connectorAccounts` from [`@deepseek-ai/dsh-client-ui-connector-account`](../../client/ui-connector-account/README.md). A plugin that connects a hosted service over MCP uses the MCP manager instead, which owns OAuth itself.

### Entry point

A plugin states its CLI path in runtime context, subclasses the runtime, and runs each command through its control:

```ts
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CliAccountRuntime, CliCommandExecutor, executableFileName, exitFailure, registerCliPathContext, type CliOperationControl } from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-subprocess'

declare const ctx: Context
const executable = join('/opt/vendor/bin', executableFileName('vendor-cli'))

class Account extends CliAccountRuntime<{ readonly state: 'unchecked' | 'out' | 'in' }, 'check', never> {
  protected async perform(_kind: 'check', control: CliOperationControl<never, 'status'>, signal: AbortSignal): Promise<void> {
    const result = await control.run('status', ['auth', 'status'], signal)
    if (result.exitCode !== 0) throw new Error('vendor-cli: auth status failed')
    this.publish({ state: result.stdout.trim() === 'authorized' ? 'in' : 'out' })
  }
}

registerCliPathContext(ctx, { name: 'vendor:cli', product: 'Vendor', program: 'vendor-cli', executable })
const account = new Account({
  name: 'vendor', logger: ctx.logger, account: { state: 'unchecked' }, check: 'check', cancellable: [],
  authorizationHosts: ['vendor.example'], classify: exitFailure,
  cli: new CliCommandExecutor(ctx.subprocess, { program: 'vendor-cli', executable, commandTimeoutMs: 30_000 }),
})
```

`account.start(kind)` returns the operation id and throws while another operation runs. `account.snapshot()` returns the current `CliAccountView`, `account.observe(listener)` calls the listener after each change, and `account.refresh()` starts a check unless an operation runs. `account.cancel(id)` stops the named operation only in a declared cancellable phase. `account.dispose()` cancels the active operation, waits for its process to exit, and disposes the executor. The contracts in [`src/runtime.ts`](src/runtime.ts), [`src/executor.ts`](src/executor.ts), and [`src/context.ts`](src/context.ts) are authoritative.

### Runtime context

`registerCliPathContext(ctx, cli)` registers one required runtime-context entry that tells the model to run `cli.program` by `cli.executable`, the path the executor runs. With `scripts`, it also tells the model to put the executable's directory first on PATH only in the commands that run the skill's scripts, and never to run `cli.program` by name. The text follows the shell that shipped compositions give the model on the Host platform. Outside Windows it uses POSIX shell syntax: the prefix is `PATH="<executable directory>:$PATH"`, which changes PATH for that command only, and the text also forbids exporting PATH. On Windows, where the model runs PowerShell, it names the executable with the call operator, `& '<executable>'`, and gives the prefix as `$env:PATH = '<executable directory>;' + $env:PATH`, which lasts only for that call because each PowerShell call runs in a fresh process. With `ready`, the entry contributes nothing while `ready()` returns false. The text is never interpolated, and disposing the plugin removes the entry. `executableFileName(program)` names the file a plugin locates: `program`, or `program.exe` on Windows. [Model Experience](#model-experience) shows the text.

### Commands, links, and failures

A command that does not wait for the user gets the plugin's `commandTimeoutMs`, including executable lookup; a command run with `awaitsUser` waits up to 10 minutes. The executor keeps at most 1 MiB of stdout and the last 4 KiB of stderr, both counted in UTF-8 bytes and the tail cut at a character boundary, and settles only after the process exits. It reads the pipes until they close, at most until 2 seconds after the subprocess runtime reports the exit, so the result does not wait for a descendant that inherited them to close them; what the descendant writes after that is dropped. `onLine` receives each line as the command writes it: `\n`, `\r\n`, and a lone `\r` each end a line, as in Node's `readline`, so a spinner the CLI redraws with `\r` after a link line does not hold the link back. The unterminated rest arrives at exit, and a line longer than its stream's limit is skipped whole rather than truncated. No line arrives after the command settles. A command rejects instead of returning its exit code when executable lookup or spawning fails, the deadline elapses, the process ends by a signal, or stdout exceeds 1 MiB; the plugin's classification then sees a null exit code.

`offer(url)` accepts only an HTTPS URL without credentials on one of the plugin's `authorizationHosts` or their subdomains, and returns whether it accepted the link. Write each host in lowercase ASCII, with an internationalized domain name in punycode, because the runtime compares it with the URL's normalized host name.

A failed operation logs and returns only the plugin's classification of its last command, `{ command, exitCode }` plus allowlisted fields; exception messages and native output are neither logged nor returned, because they may contain credentials. `failureDetails(failure)` lists the command and its exit code, such as `login` and `exit 3`, as the untranslated diagnostic items a Plugins page failure shows after the plugin's text. `accountText(dictionaries)` turns the plugin's dictionaries by language into the function its Plugins page presenter writes `LocalizedText` with, filling each `{name}` placeholder from the values it passes.

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

The runtime owns the operation lifecycle and the plugin owns the meaning of each command. One active operation holds its abort controller, phase, and link; the runtime builds the view from them and calls each observer after every change. The executor verifies the configured absolute path through the subprocess runtime and spawns it without adding environment variables; the runtime context names the same path, so the plugin and the model's Shell commands run the same executable.

| File | Role |
|---|---|
| [`src/executor.ts`](src/executor.ts) | Bounded command execution and process ownership |
| [`src/runtime.ts`](src/runtime.ts) | One-at-a-time operations, cancellation, link filtering, failure classification, and observers |
| [`src/context.ts`](src/context.ts) | The runtime-context entry that names the executable path |
| [`src/text.ts`](src/text.ts) | The `LocalizedText` a plugin's presenter writes from its dictionaries |
| [`src/types.ts`](src/types.ts) | The account view, command failure, and dictionary types |
| [`src/index.ts`](src/index.ts) | The entry module and the shared config fields |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this library and the CLI app plugins belong to.
- [Connector account surfaces](../../client/ui-connector-account/README.md) — the Plugins page registry the runtime registers with.
- [System prompt](../../core/system-prompt/README.md) — the registry that orders and renders runtime context.
- [Subprocess](../../subprocess/subprocess/README.md) — the runtime that resolves and spawns the CLI.

-----

<a id="model-experience"></a>
## Model Experience

### CLI path

#### What the model sees

One required runtime-context entry, at context order 220, for each plugin that calls `registerCliPathContext` and whose `ready` is absent or returns true; it stays when optional runtime context is off. The second line appears only with `scripts`. The placeholders come from the call. Outside Windows the quoted values are JSON strings; on Windows they are PowerShell single-quoted strings, in which a single quote is doubled.

##### Runtime-context entry

```markdown
<Product> CLI: run `<program>` by its absolute path "<executable>"; the bare name may resolve to another installation or to none.
Scripts in the <Product> skill call `<program>` by name; prefix only the commands that run them with PATH="<executable directory>:$PATH", and never export PATH or run `<program>` by name yourself.
```

##### Runtime-context entry on Windows

```markdown
<Product> CLI: run `<program>` by its absolute path with the call operator, & '<executable>'; the bare name may resolve to another installation or to none.
Scripts in the <Product> skill call `<program>` by name; start only the commands that run them with $env:PATH = '<executable directory>;' + $env:PATH, and never run `<program>` by name yourself.
```

#### Token effect

One or two lines in each runtime-context snapshot for each registering plugin. A changed path, or an entry that appears or disappears, adds one snapshot.

#### KV Cache effect

The path is runtime context rather than system prompt, so the cached prompt prefix is the same for every installation path; a change appends one runtime-context snapshot after it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The 10-minute deadline for commands that wait for the user and the 1 MiB stdout limit are fixed; a CLI whose sign-in waits longer fails with a retryable result.
- Authorization hosts match their subdomains too; a plugin cannot restrict links to one exact host.
- `exitFailure` classifies by exit code alone; a plugin whose CLI reports structured errors writes its own allowlisting classifier.
- The runtime context asks the model to run the CLI by its absolute path but cannot enforce it; a command that names the CLI by bare name runs whatever installation PATH resolves, or fails.
- The text's shell dialect follows the Host platform, not the mounted shell tool: a composition that gives the model a POSIX shell on Windows, or PowerShell elsewhere, gets the other platform's syntax.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
