# Agent Note: Windows self-hosted ReFS store and block-clone installs

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-30-windows-refs-store-block-clone-install.zh.md)

## Problem

The self-hosted Windows VM's workspaces moved from the NTFS `E:` volume to the ReFS `F:` volume. `git clean -ffdx` on the NTFS volume deleted the ~70k-file node_modules tree in tens of minutes and forced a full reinstall on every run, driving disk writes past the volume's sustained bandwidth. ReFS metadata operations are orders of magnitude faster, so the workspace move restored fast checkout, but it exposed a second failure.

The pnpm store also lives on `F:` (`F:\.pnpm-store`), so pnpm links node_modules files to the store with hardlinks (its default `package-import-method=auto` on a same-volume layout). TypeScript resolves module files with the native realpath (`fs.realpathSync.native`), which on Windows resolves a hardlink to the store's content-addressed path (`F:/.pnpm-store/v11/files/<xx>/<sha256>`). The compiler then resolves bare imports from that store path, where no `node_modules` exists, and fails with TS6231 (`Could not resolve the path 'F:/.pnpm-store/...'`) during `tsc -b` and vite's module resolution. The JS `realpathSync` does not leak the store path; only the native variant does, so this only appears in compiler tooling.

A related install failure appears when `package-import-method=clone` runs on a volume that does not support copy-on-write: pnpm reports `ERR_PNPM_LINKING_FAILED ... Source volume does not support copy-on-write` on NTFS volumes (hosted runners).

The pnpm build that `pnpm/action-setup` installs into its `dest` omits the `@reflink/reflink` native module that clone mode requires, so even on ReFS, clone fails with `Cannot find module './reflink.win32-x64-msvc-*.node'`. The system corepack pnpm carries the complete `@reflink` platform set, including `reflink.win32-x64-msvc.node`.

## Decision

The Windows install steps in [ci.yml](../../../../.github/workflows/ci.yml) (the four pull-request native jobs) and [ci-master.yml](../../../../.github/workflows/ci-master.yml) (`serial-windows`) branch on the workspace filesystem, using clone only on ReFS:

```pwsh
$drive = (Split-Path -Qualifier $env:GITHUB_WORKSPACE).TrimEnd(':')
$fs = (Get-Volume -DriveLetter $drive).FileSystem
if ($fs -eq 'ReFS') {
  corepack pnpm install --frozen-lockfile --package-import-method=clone
} else {
  pnpm install --frozen-lockfile
}
```

- `--package-import-method=clone` on ReFS uses block cloning: each node_modules file gets an independent path (so native realpath cannot resolve it back to a store path, eliminating TS6231) while sharing physical blocks with the store (no copy cost). ReFS supports block cloning and hardlinks (verified with `fsutil fsinfo volumeinfo` and hardlink listing).
- The flag is passed only when the workspace volume is ReFS. Hosted runners (NTFS, fresh VM per job) keep the default import method, because NTFS rejects block clone.
- `corepack pnpm` is used because clone mode needs the `@reflink/reflink` native module, which the system corepack pnpm carries but `pnpm/action-setup`'s dest build omits.
- `.npmrc` and `npm_config_*` environment variables do not drive `package-import-method` in pnpm 11.7.0 on Windows; only the CLI flag is honored, so the flag is explicit in the command.

The self-hosted VM's store lives on `F:\.pnpm-store` (ReFS, machine-level `PNPM_CONFIG_STORE_DIR`), and the workspaces live on `F:\ci\_work-NN`. The F: volume is 200 GB ReFS after rebuild. `DSH_CI_FAILOVER_WINDOWS=selfhosted` routes the four pull-request native jobs to the self-hosted pool.

## Alternatives considered

- **Keep workspaces on NTFS `E:`** - rejected because `git clean -ffdx` deleted the node_modules tree in tens of minutes on NTFS, the original write-storm cause; ReFS reduced it to ~23 seconds.
- **`--package-import-method=copy`** - avoids the store-path leak (files are independent copies) and needs no native module, but copies every file from the store on every install, restoring most of the write cost the workspace move removed.
- **Fix the action-setup pnpm's reflink** - rejected because `pnpm/action-setup` installs a fresh pnpm into a per-job `dest` directory; adding the native module there is fragile and per-job.
- **`.npmrc` `package-import-method=clone`** - rejected because pnpm 11.7.0 on Windows ignores it (verified: files remain hardlinks with `nlink=2` and native realpath still leaks the store path).

## Consequences

The self-hosted Windows installs use block cloning, giving independent file paths (no TS6231) with shared physical blocks (no copy). Hosted runners keep the default import method. The `serial-windows` standby drill and the pull-request native jobs on the self-hosted pool depend on the ReFS volume layout; a runner rebuilt from the [failover runbook](2026-07-26-ci-failover-runbook.md) without the ReFS store-and-workspace layout would fail the Windows build gates with TS6231 (or the install with reflink errors).
