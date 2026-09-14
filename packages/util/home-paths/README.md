---
description: "Shared resolution of the DeepSeek Harness home and user-data paths for packages that need one consistent root, tilde expansion, and stable watch paths."
kind: "package-library"
---

# @deepseek-ai/dsh-home-paths

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-home-paths` lets package authors resolve one DeepSeek Harness data root and derive child paths from it. An explicit path wins over `$DSH_HOME`, which wins over `~/.dsh`; blank environment values are ignored. Its public helpers can render the root without revealing an absolute machine path, expand only bare or current-user tilde forms, and canonicalize watch targets whose final components do not yet exist. Use it as a direct library dependency, not through `cordis.yml`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use these helpers wherever a package must agree with the rest of the harness about where user data lives: resolve the home once, then derive every child path from it.

### Resolving the home

```ts
import { resolveDshHome, dshHomePath, dshCachePath } from '@deepseek-ai/dsh-home-paths'

const home = resolveDshHome()                // configured path, else $DSH_HOME, else ~/.dsh
const settings = dshHomePath('settings')     // join one child onto the resolved home
const cache = dshCachePath('models')         // $DSH_HOME/cache/models, default ~/.dsh/cache/models
```

An explicit configured path has the highest precedence, then `$DSH_HOME`, then the default `~/.dsh`. An empty or whitespace-only `$DSH_HOME` is treated as unset, so a blank override never resolves the home to the current working directory.

`dshCachePath(...segments)` derives paths from the resolved home's `cache` directory. With no segments it returns the cache directory itself. Pass an initial options object, `dshCachePath({ dshHome: home }, ...segments)`, to use an explicit configured home with the same precedence and tilde expansion. It returns an absolute path without creating directories.

### Displaying a home

For user-facing paths, render the root symbolically rather than as a machine path: the default home displays as `~/.dsh` and any configured home displays as `$DSH_HOME`. The display form never leaks an absolute machine path.

### Expanding user paths

`expandHomePath` expands a leading `~`, `~/`, or `~\` against the operating-system home and leaves everything else untouched — non-tilde paths and named-user forms such as `~alice/...` pass through unchanged.

### Canonicalizing watch paths

`canonicalizeWatchPath` gives a native filesystem watcher one canonical spelling of its target: the deepest existing ancestor is resolved through `realpath` and any missing suffix is restored, so a file or directory can be watched before it is created. This prevents Windows from treating a regular-file ancestor as ordinary absence, and prevents 8.3 short-name aliases from mixing with the long paths the native watcher backend emits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is built on one principle: all harness user data lives under one root, and every other helper derives from that decision.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Home resolution, path joining, display, tilde expansion, and watch-path canonicalization |
| — | No runtime invariant companion is published; this pure utility owns no event stream or mutable runtime data; its resolution rules and value algebra are enforced by unit tests. |

### Resolution rules

`resolveDshHome` reads the explicit override, then `$DSH_HOME`, then falls back to the operating-system home joined with `.dsh`. The chosen value is tilde-expanded and normalized to an absolute path; `dshHomePath` joins child segments with Node's platform path rules. `dshHomeDisplay` compares the resolved path against the default root and returns the symbolic label, so a configured home never leaks its absolute path.

### Canonicalization mechanics

`canonicalizeWatchPath` walks up from the target until it finds an existing ancestor, resolves it with `realpath`, proves it is an enumerable directory, and restores the missing suffix. Errors other than absence propagate, and a missing-suffix ancestor that is not a directory is rejected.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the launcher or the consumers that depend on a single home root.

- [Boot package](../../boot/app-boot/README.md) — the launcher that resolves the home before any plugin mounts.
- [Shell environment](../../shell/shell-env/README.md) — how `DSH_HOME` reaches model shell calls.
- [Anonymous user id](../../identity/anonymous-user-id/README.md) — a stored identity file under the resolved home.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the helpers are not the right tool. They are current package constraints, not a task backlog.

- **Expansion is deliberately narrow** — only bare `~`, `~/...`, and `~\...` use the current operating-system home; named-user forms such as `~alice/...`, environment variables, and shell expressions remain unchanged.
- **Canonicalization reads but never mutates** — `canonicalizeWatchPath` performs `realpath` probes and propagates errors other than absence; callers still own directory creation, permissions, and trust policy for the resulting path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
