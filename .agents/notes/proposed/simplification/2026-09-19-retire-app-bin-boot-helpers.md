# Agent Note: Retire app-boot helpers used only by fixtures

Status: proposed

English | [中文](2026-09-19-retire-app-bin-boot-helpers.zh.md)

## Problem

[App boot](../../../../packages/boot/app-boot/src/index.ts) exports `resolveConfigPath`, including a basename-specific replay substitution, and `loadEnv`, which reads one optional `.env`. The supported [CLI launcher](../../../../apps/cli/src/bin.ts) uses `loadLayeredEnv`; [profile boot](../../../../apps/cli/src/profile-boot.ts) supplies an absolute path directly. Neither production path calls the older helpers.

An exact-symbol search across packages, apps, and scripts finds ten `resolveConfigPath` calls in eight fixture drivers, all passing `undefined` for replay mode. The only non-unit `loadEnv` caller is the [Loader smoke fixture](../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts). The [snapshot launcher](../../../../packages/test-support/session-snapshot/src/launcher.ts) separately owns replay patch selection. The old helpers consequently retain two public APIs, unused production replay policy, and dedicated tests for fixture-only needs.

The [shared app-bin glue record](../../archived/simplification/2026-07-04-share-app-bin-boot-glue.md) explains the original shared-bin use. The active [single-launcher decision](../../implemented/architecture/2026-08-22-single-dsh-application-launcher.md) replaces those supported entry paths. This is partial supersession: `boot` and fail-loud handling still have owners, and the archived record remains frozen.

## Proposal

Delete `resolveConfigPath` and `loadEnv` from the production export. Use Node's `path.resolve` in the eight fixture drivers. Keep optional one-directory `.env` handling local to the sole fixture that needs it, including its absent-file and warning behavior; do not introduce a replacement production package.

Remove helper-specific tests and update app-boot's package description, README pair, and `boot` JSDoc. Keep `boot`, `loadLayeredEnv`, shipped profile composition, and snapshot replay selection. The identified removal is 39 production source/JSDoc lines and about 73 dedicated test lines, less the small fixture-local environment handling and builtin imports; the estimate is not an implemented diff.

## Alternatives considered

**Keep public conveniences for low-level embedders.** They can be useful, but current fixtures request only path resolution and one optional file read. Maintaining a second production replay selector and obsolete app-bin guidance is disproportionate to those uses.

**Replace every use with `loadLayeredEnv`.** Rejected because layered discovery, filtering, and precedence differ from reading one fixture-local `.env`. Sharing a name does not establish equivalent behavior.

## Acceptance criteria

- Exact-name searches find no live helper imports or calls. All ten path replacements remain absolute and select the same files.
- The sole environment-loading fixture preserves missing-file, present-file, and warning behavior; helper-only tests disappear without dropping retained boot coverage.
- Run focused app-boot and affected fixture-entry tests, including built entry checks where required, a shipped profile smoke, and a keyless replay scenario.
- Update README pairs and package/JSDoc descriptions; run build, relevant hygiene, typecheck, doc-sync, and lint. Add no compatibility aliases or second replay selector.

## Risks

Out-of-tree callers importing these pre-stable helpers must use the retained profile APIs or own their low-level path/environment policy. Accidentally switching the fixture to layered environment discovery would change its test inputs; preserve that distinction explicitly.
