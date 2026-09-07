# Agent Note: Follow symlinked instruction files

Status: implemented

English | [中文](2026-07-21-follow-instruction-symlinks.zh.md)

## Problem

The [agent-instructions plugin](../../archived/feature/2026-06-24-workspace-context.md) probed each instruction candidate with `ctx.fs.lstat` before resolving, rejecting any final-component symlink so a repository-owned link could not point instruction loading at content outside the workspace. That no-follow invariant blocked a deliberate, supported setup: a user who symlinks `$DSH_HOME/AGENTS.md` — or a project `AGENTS.md` — to a canonical instruction file kept elsewhere, sharing one house-style file across tools and homes, saw the link silently ignored. It also forced content dedup to treat the ubiquitous `CLAUDE.md → AGENTS.md` mirror as a special skipped case rather than an ordinary duplicate. The repository owner asked to follow symlinked instruction files unconditionally across every scope, accepting the residual trust-boundary risk recorded below.

## Decision

Instruction discovery no longer inspects the final component with `lstat`. Every candidate — the user-global `$DSH_HOME/AGENTS.md`, each base candidate, and each local-overlay candidate — is resolved and its resolved target is stat-ed, at baseline composition and at each `tools/post-execute` reconciliation alike. A symlink whose target is a regular file loads that target's content; a resolved non-file target (including a link to a directory) is a confirmed absence that removes the scope like a missing file; a `resolve` or `stat` exception is classified as temporarily unavailable and never removes an already-loaded scope. `nodeStatFile` calls `stat` (host path) and `fsStatFile` calls `resolve` then `stat` (provider path); neither calls `lstat`.

A followed symlink is an ordinary file for every downstream step. It participates in per-directory content dedup ([load-all + dedup note](../../archived/feature/2026-07-21-instruction-load-all-dedup.md)), so a `CLAUDE.md` that symlinks its sibling `AGENTS.md` now resolves to identical content and collapses like any byte-identical real duplicate instead of being skipped as a special case.

### Trust boundary and residual risk

Following repository-owned links crosses the plugin's trust boundary: a cloned, untrusted repository can carry an `AGENTS.md` whose symlink target is any file the process can read, surfacing off-tree content as workspace guidance. That content enters only as a lower-authority user-role prefix framed by the system-reminder pattern; it never overrides system, developer, or direct user instructions, and it is treated as data, not authority. The mitigating boundary is the filesystem layer, not this plugin: confine `ctx.fs` with the `dsh-fs-observation-policy` gate or an OS sandbox ([cross-family fs sandbox](2026-07-14-cross-family-fs-sandbox.md)) when a deployment loads untrusted repositories. This is an explicit, owner-accepted trade-off, not an oversight.

## Alternatives considered

**Keep the `lstat` no-follow invariant.** Rejected by the repository owner: it blocks the supported symlink-to-canonical-file setup and forces the symlink-mirror case to be a skipped special case rather than a plain duplicate. The read-authority boundary it approximated belongs in the filesystem policy and sandbox layer, which contains the same risk more precisely.

**Follow only the user-global `$DSH_HOME` candidate and keep no-follow for project files.** Rejected: the owner asked for uniform behavior across every scope, and a split rule is harder to reason about than one consistently applied policy plus a documented boundary. A project the user chose to open is not meaningfully more trusted than the user's own home.

**Follow symlinks but reject targets that resolve outside the project root.** Rejected: it reintroduces a partial trust boundary in the wrong layer — path geometry rather than read authority — breaks the legitimate `$DSH_HOME`-to-elsewhere case, and duplicates containment the filesystem policy gate already owns.

## Consequences

A symlinked instruction file is now loaded and rendered like its target, enabling shared canonical instruction files across tools and homes, and the `CLAUDE.md → AGENTS.md` mirror deduplicates through content instead of being skipped. The plugin no longer depends on `ctx.fs.lstat` for instruction loading; a resolved non-file is a confirmed absence and only a provider exception is temporarily unavailable. The trust boundary moves out of this plugin into the filesystem policy and sandbox layers, which must confine `ctx.fs` when a deployment loads untrusted repositories. The [agent-instructions note](../../archived/feature/2026-06-24-workspace-context.md) and the package README carry the same follow behavior and residual-risk statement.
