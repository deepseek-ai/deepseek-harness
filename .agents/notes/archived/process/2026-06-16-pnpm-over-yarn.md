# Agent Note: pnpm as the package manager instead of Yarn 4

Status: implemented
Archived: 2026-09-30

English | [中文](2026-06-16-pnpm-over-yarn.zh.md)

## Problem

The repo shipped on **Yarn 4** with the `node-modules` linker — a deliberately conservative choice that behaves like npm's flat layout while giving us Yarn's workspaces and `yarn constraints`. It worked. But Yarn 4's Plug'n'Play heritage makes the `node-modules` linker the off-the-beaten-path mode, and the broader JS ecosystem — tooling defaults, CI actions, Corepack examples, contributor familiarity — increasingly centers on pnpm. For a repo that is built primarily by agents and read by occasional human contributors, "the package manager most tools and people expect" has real value: fewer surprises, better-trodden failure paths, more copy-pasteable answers.

The switching cost is at its lowest right now. Nothing publishes from this repo yet (every package is `private: true`); development, tests, and source-mode demos run through their declared TypeScript launchers, while artifact checks build explicitly. The package manager therefore only has to (a) resolve and link `node_modules`, (b) run the workspace scripts, and (c) enforce the workspace constraints. The one Yarn-specific asset is `yarn.config.cjs` (the `@yarnpkg/types` constraints engine), which is small and mechanical to re-express. This mirrors the reasoning in [the tsdown decision](../../archived/process/2026-06-11-tsdown-over-dumble.md): swap a load-bearing tool for the healthier-ecosystem option while the blast radius is still small.

## Decision

Adopt **pnpm 11.7.0**, pinned via the `packageManager` field. Contributor setup uses Corepack, while CI installs that pin through `pnpm/action-setup`:

- **Workspaces** move from the `package.json` `workspaces` array + `.yarnrc.yml` to `pnpm-workspace.yaml`; vendored packages, grouped packages, applications, the website, native launchers, and the Python runtime closure are explicit members.
- **Strict symlinked linker** (pnpm's default) replaces Yarn's hoisted `node-modules` linker. We deliberately add **no** `node-linker=hoisted` / `shamefully-hoist` escape hatch: pnpm's non-flat `node_modules` makes phantom dependencies (importing an undeclared transitive dep) fail loudly, which is a *feature* for a repo whose whole quality story is mechanical gates ([mechanical quality gates](2026-06-11-quality-gates.md)). The gate suite — typecheck, lint, test, and build — is the safety net that proves no such phantom imports exist.
- **Build-script allowlist.** pnpm 10+ does not run dependency lifecycle scripts unless allowlisted. `pnpm-workspace.yaml` carries an explicit `allowBuilds` map (`esbuild`, `lefthook`, `@google/genai`, `protobufjs`) — the same supply-chain-hardening posture the repo already takes toward model/tool output, now applied to install-time code execution. `peerDependencyRules.allowedVersions.typescript: '>=5 <7'` silences benign peer-range warnings for the in-repo TypeScript.
- **Shell-free package-manager re-entry.** Repository scripts that start another pnpm command resolve `npm_execpath` by file form: `.js`, `.cjs`, and `.mjs` entries run under the current Node executable, while native and shebang executables run directly. Neither path uses a shell, so command paths and arguments retain their literal contents across platforms. The [native Windows pull-request job](2026-08-08-native-windows-pull-request-ci.md) provisions `@pnpm/exe`, so its complete inventory supplies a real PE-entry integration signal.
- **Constraints become package-manager-independent.** `yarn.config.cjs` (which imported `@yarnpkg/types` and used `Yarn.workspaces()` / `workspace.set()`) is replaced by `scripts/check-workspace-constraints.ts`, a plain tsx script run as `pnpm run constraints`. It enforces the identical invariants — every package `private: true`; `@deepseek-ai/dsh-*` packages declare `cordis` as both a peer- and dev-dependency with matching ranges, use the root `package.json` version, and set `type: module`; vendored packages checked for privacy only — over the same `vendor` + `packages` scope.
- All `yarn …` verbs across CI, lefthook hooks, `package.json` scripts, and docs become `pnpm …` / `pnpm run …`. `yarn.lock` → `pnpm-lock.yaml` (lockfile v9). `.gitignore` swaps `.yarn/` for `.pnpm-store/`. Vendored READMEs (e.g. `vendor/cordis/README.md`) keep their upstream `yarn` examples untouched per the Vendoring Policy.

## Alternatives considered

- **Keep Yarn 4** — zero churn, but bets on the less-traveled linker mode and a constraints engine tied to one package manager.
- **npm workspaces** — ubiquitous, but no constraints story and weaker monorepo ergonomics.
- **pnpm with the hoisted linker** — smoother migration, but throws away the phantom-dependency safety that is the main correctness reason to move.
- **Always run `npm_execpath` through Node** — works for pnpm's JavaScript distribution but asks Node to parse the ELF, Mach-O, or PE executable supplied by `@pnpm/exe`.
- **Run re-entry commands through a shell** — accepts more launcher forms but changes quoting, metacharacter expansion, executable resolution, and signal behavior for every child command.

## Consequences

The constraints check loses Yarn's auto-**fix** (`workspace.set()` could rewrite a manifest in place); the tsx script is check-only and exits non-zero with a message instead. This is acceptable — CI never ran `--fix`, and a one-line manual edit is rare. Contributors now `corepack enable` for pnpm rather than Yarn; `pnpm exec lefthook install` replaces `yarn lefthook install` (the `postinstall` hook still runs `lefthook install`).

Performance (measured at migration time on the dev NFS filesystem; single-digit-run samples, high variance — directional, not a benchmark suite):

| Scenario | Yarn 4 | pnpm 11 |
|---|---|---|
| Cold (empty cache/store, no `node_modules`) | ~14 s | ~16 s |
| Warm relink (cache/store warm, `node_modules` removed) | ~12–14 s | ~15–22 s |
| Frozen, `node_modules` present (no-op revalidate) | ~2–8 s | ~0.5–7 s |

On a fast local disk pnpm's content-addressed store typically wins on cold/warm installs and, especially, on **disk footprint** across multiple checkouts (one global store hardlinked into every `node_modules` vs Yarn copying ~279 MB per worktree — some devs regularly keep ~10 or more worktrees for this repo). That dedup advantage did **not** show in the migration-time numbers above because the test store and `node_modules` sat on different filesystems, defeating hardlinks; on a single-filesystem dev box or CI cache it applies. The honest summary: install speed on our NFS dev filesystem is a wash within noise; the move is justified by ecosystem alignment, phantom-dependency safety, and cross-checkout disk dedup — not by a raw install-time win.

All quality gates (constraints, typecheck, lint, doc-sync, test:coverage at 100%, build, publint, and built application smokes) pass on pnpm, which is the correctness proof that the linker swap introduces no phantom-dependency breakage.
