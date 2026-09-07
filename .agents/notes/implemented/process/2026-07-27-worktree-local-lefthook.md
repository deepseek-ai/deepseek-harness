# Agent Note: Make Lefthook installation worktree-local

Status: implemented

English | [中文](2026-07-27-worktree-local-lefthook.zh.md)

## Problem

Every `pnpm install` runs the root [`postinstall`](../../../../package.json), whose [`install-lefthook.mjs`](../../../../scripts/install-lefthook.mjs) invokes `lefthook install --force`. Linked Git worktrees otherwise share the common repository's default hooks directory, so an install in any worktree can rewrite hooks used by every other worktree.

Lefthook-generated hooks prefer an absolute binary path captured from the installing worktree before trying their current-worktree fallback. Shared hooks can therefore run another worktree's pinned binary until that worktree disappears, while concurrent installs write the same files.

## Decision

Hook installation is worktree-scoped. With `CI=true` or `GITHUB_ACTIONS=true`, the installer returns before Git discovery or mutation because automated jobs do not consume contributor hooks. Otherwise, it requires Git 2.26 or newer so `git config --show-scope` can report which scope supplied a value, upgrades a format-0 repository to format 1, enables `extensions.worktreeConfig`, and assigns the current worktree an absolute `core.hooksPath` at `$GIT_DIR/dsh-hooks`.

Before upgrading format 0, the installer refuses direct common-config `extensions.*`; it also refuses direct `core.worktree` or `core.bare=true` and non-empty dormant worktree configs that enabling the extension would activate. The migration removes direct `core.bare=false` because false is Git's default. The common repository config and every existing `config.worktree` must be regular files. These checks disable include expansion because Git's repository-format parser also ignores included targets. A repository-scoped lock serializes migration and hook writes; its process ID, random token, file identity, and exact contents must still match at release. Dead or invalid locks require manual recovery rather than automatic breaking.

Each hook directory carries a JSON ownership marker containing the absolute path last published to worktree config. After a checkout moves, that marker permits replacement of only the exact stale owned value. Git seeds a new linked worktree's `config.worktree` from the main worktree; when that seed contains the marker-backed reserved hook path of a registered worktree, the installer replaces only the new worktree's config with its own path. Before Lefthook runs, the marker and every existing generated hook must be unaliased regular files. The installer resolves the effective scope, origin, and value of `core.hooksPath`, including active `config.worktree` includes; it refuses command-scoped paths, unowned worktree-scoped paths, and unowned reserved directories. An inherited system, global, or common-repository path requires `DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1`, which opts only the current worktree into Lefthook. Inactive `includeIf` targets are not recursively inspected because they do not affect the current configuration. Command-scoped Git configuration is removed from the Lefthook subprocess environment after validation.

If Lefthook fails after changing `core.hooksPath`, the installer restores the previous worktree value; a rollback failure is reported alongside the installation failure. Existing files in `$GIT_COMMON_DIR/hooks` are never removed or rewritten. Focused installer tests pin isolation, copied new-worktree configuration, migration refusal, ownership and relocation, concurrent installation, custom paths, and rollback.

## Alternatives considered

**Keep the shared generated hooks and rely on their current-worktree fallback.** The captured absolute path wins while its worktree exists, so the fallback does not provide version or lifecycle isolation.

**Point every worktree at one checked-in `.githooks` directory.** A relative tracked directory removes generated absolute paths, but changing the shared `core.hooksPath` can disable hooks in older worktrees whose branches do not contain that directory and still couples every worktree to one shared configuration value.

**Build a general hook-manager chaining layer.** Ordering, argument forwarding, failure semantics, and upgrades become repository-owned behavior unrelated to Lefthook isolation. The installer instead refuses worktree-specific custom paths and makes the narrower inherited-path override explicit.

**Whitelist provider-specific CI credential-include paths.** Contributor hooks are unused in CI, so path exemptions would couple installer safety to provider checkout internals and weaken strict validation for contributor installs. The CI no-op avoids repository mutation without any exemptions.

**Stop installing hooks automatically.** Manual setup avoids shared writes but makes the repository's cheap commit and push checks optional by accident, especially in short-lived agent worktrees.

## Consequences

Installing or removing one worktree no longer changes another worktree's active hooks, binary path, or generated hook bytes. Concurrent installs are serialized and repeated installation is idempotent, while the jobs and latency boundary owned by [Fast local Git hooks](../../archived/process/2026-07-22-fast-local-git-hooks.md) stay unchanged.

The repository becomes a Git format-1 repository after the first installation. The installer requires Git 2.26 for `--show-scope`; the worktree-config extension itself predates that command. Custom worktree hook managers require an explicit integration choice; inherited hook paths can coexist across other worktrees, but opting the current worktree into Lefthook means those inherited hooks do not run there unless the contributor chains them through `lefthook.yml`.

Legacy common hooks remain on disk for unupgraded worktrees. They can become stale, but removing them automatically would break a registered worktree whose branch has not adopted this installer.
