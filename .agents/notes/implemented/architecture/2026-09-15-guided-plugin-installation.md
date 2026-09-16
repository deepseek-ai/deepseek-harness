# Agent Note: Guided plugin installation

Status: implemented

English | [中文](2026-09-15-guided-plugin-installation.zh.md)

## Problem

The install dialog put a spec straight into `pnpm add` and showed pnpm's terminal as the whole story: a typo, an installed package, a missing path, and a registry outage all ended in the same red exit code, the person read pnpm's output to learn which, and nothing could be stopped once started. A run that failed, or that added a package without a bundle patch, left the dependency in the profile with nothing in the list to show or remove it. Enabling was a checkbox to tick before knowing what would be installed, and a finished install left the new package somewhere in the list.

## Decision

**The Host reads a spec before installing it.** `PluginManager.inspect` sorts the spec — registry name, absolute path, git address, tarball — with `parseInstallSpec`, refuses what pnpm or the registry would refuse, and asks the registry through `pnpm view` or the directory through its `package.json` for the name, version, description, and bundle declaration. `pnpm view` runs in the profile directory so the registry and proxy settings match the install. A package without a bundle patch is refused here, before pnpm runs: the manager installs bundles only. The answer carries one of seven problems; the client renders each as a sentence under the field and keeps the spec editable. The dialog refuses a name the list already shows without asking the Host.

**A failed or cancelled installation restores the profile files.** `installBundle` snapshots `package.json` and `pnpm-lock.yaml` before pnpm runs and puts them back when pnpm fails, when the run is cancelled, or when the package pnpm added declares no bundle patch. This reverses, for installations only, the [manager's decision](2026-09-14-current-profile-plugin-management.md) to retain partial changes: an installation that did not produce a usable bundle must not leave a dependency the page cannot show. Removals keep that decision. Downloaded files can stay under `node_modules` and the pnpm store.

**A failed run is classified where the facts are.** `classifyInstallFailure` reads how the run ended and what pnpm printed — its `ERR_PNPM_*` codes and Node's errno names — into `packageResult.kind`. The client shows the kind as one line and folds pnpm's output behind the details. Parsing the log is confined to this one function with a fixture-driven test.

**Cancellation is the manager's, not the signal's.** The dialog generates a request id for each run; the Host streams the run's output and phases under it, and `cancelInstall` answers only after pnpm exited and the files are back. The dialog waits for that answer before offering the spec again; an aborted RPC or a lost connection is not a confirmation. Only the check takes a trailing `AbortSignal`: going back or closing drops a registry lookup, whose settlement nothing waits for.

**Enabling comes after the fact.** The run installs with `enabled: false`; the finished screen offers **Enable now** for the bundle it added, and the dialog closes and the list scrolls to it. Nothing is enabled before the person has seen what was installed.

**Outcomes of the moment are toasts.** A change that waits for the next start, one a higher layer overrides, a cancelled run, and a refused action each toast and retire; nothing stays on the page.

**Blocked install scripts are approved from the failed screen.** When pnpm 11 leaves a dependency's scripts undecided, the failed run reports the pending names ([the manager's approval](2026-09-14-current-profile-plugin-management.md)), and the failed screen shows them with **Allow these scripts and retry** in place of plain retry; the store runs the same checked subject again with `approvedBuilds`, and the installed screen names what was allowed. `pnpm-workspace.yaml` is not among the restored files for this reason. Without pending names the failure falls back to the manual instruction.

## Alternatives considered

**Validate specs on the client.** Rejected: the rules are pnpm's, the registry's, and the profile's, and the client cannot import the Host package that owns them.

**Look the package up over HTTP instead of `pnpm view`.** Rejected: the registry, proxy, and auth settings that decide whether the install can succeed live in pnpm's configuration, which `pnpm view` reads and a direct fetch would have to reimplement.

**Stop the run by aborting the add RPC.** Rejected: a dropped RPC does not say whether pnpm stopped or the manifest is back, so the dialog would offer the spec again over a run still writing to the profile. The manager's `cancelInstall` answers only after cleanup, and the dialog waits for it.

**Keep listing dependencies that are not bundles.** Rejected: the manager manages bundles, and a package it refuses to install cannot be listed or removed through it; the check refuses such a package before anything is written.

## Consequences

`inspect`, `cancelInstall`, and the `plugin-manager/changed`, `plugin-manager/install-log`, and `plugin-manager/install-state` events join the manager's Remote; `listBundles` carries titles, rows, and overrides; `ChangeResult` gains `cancelled`, `bundle`, and `packageResult.kind`; the config gains `pnpmCommand` and `inspectTimeoutMs`. The dialog is four screens over one subject card.

## Testing

`packages/boot/plugin-manager/tests/install-spec.spec.ts` pins the spec forms and the failure classifier's inputs; `manager.spec.ts` drives `inspect` against a stubbed registry lookup and a real directory, streams a run, stops one and checks the restored files, and checks the change events; `operations.spec.ts` covers the registry lookup. `packages/client/ui-plugin-manager/tests` cover the store's phases, Host-confirmed cancellation, post-install enabling, toasts, and the page's four screens; `apps/web/tests/plugin-manager.e2e.ts` refuses an installed name, a missing path, and a bad name through the real Host and switches a bundle and one of its rows live, and `plugin-install-cancel.e2e.ts` stops a real child from the dialog, checks the restored files, and installs on the second try, and `plugin-install-approve.e2e.ts` leaves a script undecided through the fake pnpm, allows it from the dialog, and installs on the retry.
