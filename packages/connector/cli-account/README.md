---
description: "Register a CLI app plugin's vendor CLI and account with the Host Service `ctx.cliAccounts`: the model gets the CLI's absolute path in runtime context, account operations run one at a time through bounded commands, and the account appears on the Plugins page."
kind: "package-reference"
---

# @deepseek-ai/dsh-cli-account

English | [中文](README.zh.md)

## Summary

CLI app plugins such as Feishu and WeCom register their vendor CLI and its account once with `ctx.cliAccounts`. The model then reads the CLI's absolute path in runtime context, and the Plugins page shows the account with the plugin's own text. The Service runs the plugin's account operations one at a time, gives each command a deadline and an output limit, and passes authorization links to the page only from the hosts the plugin trusts. Each plugin keeps its own commands, parsing, and account states. The base bundle loads the Service, which does nothing until a plugin registers.

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

A CLI app plugin's Host row injects `cliAccounts` and calls `register` once; the registration lasts until the plugin unloads or disposes the returned handle.

### When to choose it

Register from the Host row of a plugin whose vendor CLI signs the user in and keeps the credentials, so DSH only starts commands, shows their results, and owns their processes. A plugin that connects a hosted service over MCP uses the MCP manager instead, which owns OAuth itself. The Service shows each account through `ctx.connectorAccounts` from [`@deepseek-ai/dsh-client-ui-connector-account`](../../client/ui-connector-account/README.md), which a plugin without a vendor CLI registers with directly.

### Minimal configuration

The [base bundle](../../bundle/base/cordis.patch.yml) loads the Service in every profile built on it, beside the `subprocess` and `systemPrompt` services it injects:

```yaml
- id: cli-account
  name: '@deepseek-ai/dsh-cli-account'
```

| Field | Default | Meaning |
|---|---|---|
| `commandTimeoutMs` | `30000` | Deadline in milliseconds for a command that does not wait for the user, including executable lookup; it applies to every registered CLI |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-cli-account) is the exhaustive source for every accepted field. A value below 1 or above 2147483647 fails at load.

### Register a CLI and its account

The plugin's Host row lists `cliAccounts` in `inject` and registers from `apply`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { CliAccountRegistration } from '@deepseek-ai/dsh-cli-account'

interface Account { readonly state: 'unchecked' | 'out' | 'in' }

const dictionaries = {
  en: { title: 'Vendor account', hint: 'The account vendor-cli keeps.', connect: 'Connect', in: 'Connected', out: 'Not connected' },
  zh: { title: 'Vendor 账号', hint: 'vendor-cli 保管的账号。', connect: '连接', in: '已连接', out: '未连接' },
}

const registration: CliAccountRegistration<Account, 'check', never, 'status', keyof typeof dictionaries.en> = {
  name: 'vendor',
  packageName: '@acme/dsh-vendor',
  cli: { product: 'Vendor', program: 'vendor-cli', executable: '/opt/vendor/bin/vendor-cli' },
  account: { state: 'unchecked' },
  check: 'check',
  cancellable: [],
  authorizationHosts: ['vendor.example'],
  async perform(_kind, control, signal) {
    const result = await control.run('status', ['auth', 'status'], signal)
    if (result.exitCode !== 0) throw new Error('vendor-cli: auth status failed')
    control.publish({ state: result.stdout.trim() === 'authorized' ? 'in' : 'out' })
  },
  dictionaries,
  operations: () => [{ kind: 'check' }],
  copy: text => ({ title: text('title'), hint: text('hint'), activation: { title: text('title'), body: text('hint'), connect: text('connect') } }),
  present: (view, text) => view.account.state === 'in'
    ? { phase: 'connected', status: text('in'), buttons: [], notes: [] }
    : { phase: 'disconnected', status: text('out'), buttons: [], notes: [] },
}

export const inject = ['cliAccounts']

export function apply(ctx: Context): void {
  ctx.cliAccounts.register(registration)
}
```

`register` adds the CLI's path to runtime context, runs `perform` for one operation at a time, and shows the account on the Plugins page while `connectorAccounts` is loaded; a composition without that registry, such as a headless profile, gets the first two. The registration belongs to the plugin whose `ctx` made the call. Unloading that plugin removes the account from the Plugins page, cancels the active operation, waits for it and for the CLI processes it started, and then removes the runtime-context entry. A second registration under one `name` throws and leaves the first in place.

- `name` is the plugin's short name: the prefix of its errors and log records, and the stem of its runtime-context name `<name>:cli`.
- `packageName` is the npm package whose Plugins page shows the account.
- `cli` names the product, the program, and the absolute path of the executable that the model and the operations both run.
- `account` is the account before the first check, and `check` is the operation the page starts for each new subscriber when none runs.
- `prepare` is optional: what the plugin puts in place before its account can be checked, such as a download of the CLI or of its skills. [Prepare before a check](#prepare-before-a-check) describes it.
- `perform(kind, control, signal)` carries out one operation: `control.run` runs one command of the CLI, `control.stage` enters a phase of the plugin, `control.offer` offers an authorization link to the page, and `control.publish` replaces the account.
- `operations(text)` lists the operations a page button may start, `copy(text)` writes the fixed text of the account section, and `present(view, text)` maps the current view to what the section shows. `text(key, params)` writes one key of `dictionaries` in every language they hold and fills each `{name}` placeholder from `params`; the browser resolves the result in its active language.

The returned handle serves the plugin outside an operation: `snapshot()` returns the current `CliAccountView`, `publish(account)` replaces the account, `refresh()` starts a check unless an operation already runs, and `dispose()` withdraws the registration before the plugin unloads. The JSDoc in [`src/types.ts`](src/types.ts) states each member's exact behavior.

<a id="prepare-before-a-check"></a>
### Prepare before a check

A plugin whose CLI or skills are downloaded after load registers `prepare: { phase, unprepared, ready, run }`. While `ready()` returns false, each `check` operation enters `phase`, awaits `run(signal)`, enters the Service's `checking` phase, and only then calls `perform`; the other operations call `perform` at once. When `run` throws, the account becomes `unprepared`, `perform` is not called, and the operation fails without a command in its result. The page can cancel `run` when `phase` is listed in `cancellable`: the signal aborts, the account becomes `unprepared`, and the operation ends as cancelled. `run` is not called while `ready()` returns true, and the next check calls it again after a failure, which makes the page's retry button the way to repeat a download. A check that calls `perform` while the account is still the `unprepared` object first replaces it with the registration's `account`: once nothing is missing, a `perform` that fails without publishing leaves the first account, not `unprepared`.

### Runtime context

`register` adds one required runtime-context entry, named `<name>:cli`, that tells the model to run `cli.program` by `cli.executable`, the path the operations' commands run. With `cli.scripts`, it also tells the model to put the executable's directory first on PATH only in the commands that run the skill's scripts, and never to run `cli.program` by name. The text follows the shell that shipped compositions give the model on the Host platform. Outside Windows it uses POSIX shell syntax: the prefix is `PATH="<executable directory>:$PATH"`, which changes PATH for that command only, and the text also forbids exporting PATH. On Windows, where the model runs PowerShell, it names the executable with the call operator, `& '<executable>'`, and gives the prefix as `$env:PATH = '<executable directory>;' + $env:PATH`, which lasts only for that call because each PowerShell call runs in a fresh process. With `prepare`, the entry contributes nothing while `prepare.ready()` returns false. The text is never interpolated. [Model Experience](#model-experience) shows the text.

### Commands, links, and failures

A command that does not wait for the user gets the Service's `commandTimeoutMs`, including executable lookup; a command run with `awaitsUser` waits up to 10 minutes. `control.run` returns at most 1 MiB of stdout and the last 4 KiB of stderr, both counted in UTF-8 bytes and the tail cut at a character boundary, and settles only after the process exits. It reads the pipes until they close, at most until 2 seconds after the subprocess runtime reports the exit, so the result does not wait for a descendant that inherited them to close them; what the descendant writes after that is dropped. `onLine` receives each line as the command writes it: `\n`, `\r\n`, and a lone `\r` each end a line, as in Node's `readline`, so a spinner the CLI redraws with `\r` after a link line does not hold the link back. The unterminated rest arrives at exit, and a line longer than its stream's limit is skipped whole rather than truncated. No line arrives after the command settles. A command rejects instead of returning its exit code when executable lookup or spawning fails, the deadline elapses, the process ends by a signal, stdout exceeds 1 MiB, or `onLine` throws; an operation that then fails reports a null exit code.

`control.offer(url)` accepts only an HTTPS URL without credentials on one of the plugin's `authorizationHosts` or their subdomains, and returns whether it accepted the link. Write each host in lowercase ASCII, with an internationalized domain name in punycode, because the Service compares it with the URL's normalized host name. `control.stage(phase)` withdraws the current link, and the page can cancel an operation only in a phase listed in `cancellable`.

A failed operation returns only its last command and that command's exit code, `{ command, exitCode }`, and its log record adds only the operation's id, kind, and phase; exception messages and native output are neither logged nor returned, because they may contain credentials. On the Plugins page, `present` writes the failure's text, and the Service adds the command and its exit code, such as `login` and `exit 3`, as the untranslated diagnostic items the page shows after that text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Service owns each registration's lifetime and the plugin owns the meaning of each command. `register` runs in the calling plugin's context, so the runtime-context entry, the account runtime, and the Plugins page registration are effects of that plugin, disposed with it in the reverse order. Each registration has one runtime, whose active operation holds its abort controller, phase, and link; the runtime builds the view from them and calls each observer after every change. Each registration also has one executor, which verifies the absolute path through the subprocess runtime and spawns it without adding environment variables; the runtime context names the same path, so the plugin's operations and the model's Shell commands run the same executable.

| File | Role |
|---|---|
| [`src/executor.ts`](src/executor.ts) | Bounded command execution and process ownership |
| [`src/runtime.ts`](src/runtime.ts) | One-at-a-time operations, cancellation, link filtering, failure reporting, and observers |
| [`src/context.ts`](src/context.ts) | The runtime-context entry that names the executable path |
| [`src/text.ts`](src/text.ts) | The `LocalizedText` a plugin's presenter writes from its dictionaries |
| [`src/types.ts`](src/types.ts) | The registration, operation control, handle, account view, command failure, and dictionary types |
| [`src/index.ts`](src/index.ts) | The `ctx.cliAccounts` Service, its config, and `register` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this package and the CLI app plugins belong to.
- [Connector account surfaces](../../client/ui-connector-account/README.md) — the Plugins page registry the Service registers each account with.
- [System prompt](../../core/system-prompt/README.md) — the registry that orders and renders runtime context.
- [Subprocess](../../subprocess/subprocess/README.md) — the runtime that resolves and spawns the CLI.
- [Base bundle](../../bundle/base/README.md) — the bundle that loads the Service, and how a profile overrides one of its rows.

-----

<a id="model-experience"></a>
## Model Experience

### CLI path

#### What the model sees

One required runtime-context entry, at context order 220, for each plugin registered with `ctx.cliAccounts` whose `prepare` is absent or whose `prepare.ready()` returns true; it stays when optional runtime context is off. The second line appears only with `cli.scripts`. The placeholders come from the registration's `cli`. Outside Windows the quoted values are JSON strings; on Windows they are PowerShell single-quoted strings, in which a single quote is doubled. While no plugin is registered, the Service adds nothing to a model request.

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
- `commandTimeoutMs` is one value for every registered CLI; a plugin cannot set a deadline of its own.
- Authorization hosts match their subdomains too; a plugin cannot restrict links to one exact host.
- A failed operation reports only its last command and that command's exit code; a plugin cannot add an error code its CLI printed to the failure.
- The base bundle loads the Service whether or not a CLI app plugin is installed.
- The runtime context asks the model to run the CLI by its absolute path but cannot enforce it; a command that names the CLI by bare name runs whatever installation PATH resolves, or fails.
- The text's shell dialect follows the Host platform, not the mounted shell tool: a composition that gives the model a POSIX shell on Windows, or PowerShell elsewhere, gets the other platform's syntax.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
