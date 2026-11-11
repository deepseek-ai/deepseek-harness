---
description: "Run the packaged ripgrep binary through the composed subprocess provider, with bounded streaming for file-search consumers."
kind: "package-library"
---

# @deepseek-ai/dsh-util-ripgrep

English | [中文](README.zh.md)

## Summary

Use this library to start packaged ripgrep without a shell or a system `rg` installation. `tool-fs-search` uses collected output; `workspace-files` reads file paths incrementally and stops at its configured cap. Callers supply the working directory, arguments, stream modes, termination grace and cancellation signal, and own exit-code interpretation.

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

Import `spawnRipgrep` from this package and pass the composed subprocess service plus an explicit `SubprocessSpawnSpec`; its `argv` contains only rg arguments. The returned handle exposes collected output or piped streams as requested. With piped stdout, `readRipgrepLines` delivers newline- or NUL-separated UTF-8 records; returning false from the callback terminates rg and suppresses remaining records. It awaits stdout, the process outcome and managed-range quiescence before returning. Callback, stream and provider failures reject after cleanup. Callers classify exit codes and cancellation using their own signal.

`resolveRgPath` is available independently for consumers that only need the executable path. Resolution and spawn failures reject the call; they do not prevent importing the package. This library is a dependency, not a profile plugin.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The resolver selects the executable's existing `-rg` sidecar in a single-file runtime, otherwise the `@vscode/ripgrep` platform package. Electron paths replace `app.asar` with `app.asar.unpacked`. Every spawn prepends `--no-config` so an ambient rg configuration cannot enable a preprocessor. The subprocess provider owns environment scrubbing and termination; the caller owns deadlines and result budgets. See [the implementation](src/index.ts).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subprocess provider contract](../../subprocess/subprocess/README.md) — explicit spawn specifications and managed process ranges.
- [Model search tools](../../fs/tool-fs-search/README.md) — collected output, tool errors and result retention.
- [Workspace file search](../../api/workspace-files/README.md#search) — native ignore rules and shallow-first file/ancestor matching.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the search tools that consume the subprocess output.

#### KV Cache effect

None directly; consumers own model-visible results and request assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Co-located executable required** — resolution uses the Host's packaged binary path. A remote subprocess provider without that binary fails; there is no system-rg lookup or filesystem-traversal fallback.
- **Record buffering** — streaming retains one incomplete record plus the current stream chunk; callers whose filenames may contain newlines use NUL separators rather than newlines. Records decode as UTF-8, so a filename that is not valid UTF-8 arrives with U+FFFD replacements and cannot be opened by that string.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
