/**
 * The JavaScript API over the prebuilt `landlock-run` launcher: resolve the
 * binary for this host, build its grant argv, and run its functional probe.
 *
 * This module owns the launcher's CLI contract (`docs/cli-contract.md`) so
 * consumers never parse launcher output or spell launcher flags themselves —
 * the contract and the binaries version together in one package family,
 * which makes probe-parsing drift against the binary structurally
 * impossible. Policy stays with the consumer: this package does not know
 * what a "sandbox mode" is, only which paths are granted read or write.
 *
 * Deliberately no environment-variable overrides anywhere in this module:
 * which binary confines a process must never be decidable by the ambient
 * environment. Test injection is by function parameter.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The launcher binary's file name inside each platform package's `bin/`. */
export const LAUNCHER_BIN = 'landlock-run'

/**
 * The exit code for every launcher-level failure (usage error, unenforcing
 * kernel, unopenable grant root, failed exec). After a successful `exec`, the
 * wrapped command may also return 125, so consumers also require a matching
 * launcher-owned fatal diagnostic to attribute launcher failure. Part of the
 * CLI contract.
 */
export const LAUNCHER_FAILURE_EXIT = 125

/**
 * The probe's verdict on this host: `full` when the running kernel enforces
 * every access the launcher can govern, `partial` when an older Landlock ABI
 * governs only a subset (still confined for everything it supports), and
 * `unusable` when nothing can be enforced — a kernel without Landlock, a
 * disabled LSM, or a missing binary, all indistinguishable on purpose
 * because the consumer's answer is the same: do not trust this launcher.
 */
export type LandlockEnforcement = 'full' | 'partial' | 'unusable'

/**
 * Filesystem grants for one confined run. Everything not granted is denied —
 * Landlock rulesets are allow-lists.
 */
export interface LauncherGrants {
  /** Roots granted read + execute beneath (the launcher's `--ro`). */
  readonly readOnly?: readonly string[]
  /** Roots granted full filesystem access beneath (the launcher's `--rw`). */
  readonly readWrite?: readonly string[]
}

/**
 * Path of the launcher binary for this host: resolved from the per-platform
 * npm package `@deepseek-ai/node-addon-system-<platform>-<arch>` (npm's
 * `os`/`cpu` fields make installers fetch only the matching one). When the
 * package is not resolvable — a platform without one, or an install that
 * skipped the optional dependency — the returned fallback path points inside
 * this package's own `node_modules` and simply never exists. Existence is
 * deliberately not checked either way: {@link probe} is the single
 * availability signal (a missing binary probes `unusable` the same way an
 * unenforcing kernel does).
 * @param resolvePackageJson - test hook over `require.resolve` (the default
 *   covers real installs); receives the platform package's `package.json`
 *   specifier and returns its absolute path, throwing when unresolvable.
 * @returns the absolute launcher path to probe and exec.
 */
export function launcherPath(
  resolvePackageJson: (specifier: string) => string = createRequire(import.meta.url).resolve,
): string {
  const platformPackage = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`
  try {
    return join(dirname(resolvePackageJson(`${platformPackage}/package.json`)), 'bin', LAUNCHER_BIN)
  } catch {
    // Unresolvable platform package: no such package exists for this host, or
    // it was not installed. Fall back to the path pnpm's layout WOULD use —
    // absolute, inside this package's boundary (never cwd-relative: a
    // spawnable relative path here would hand cwd control over which binary
    // confines), and nonexistent exactly when the package is absent.
    return fileURLToPath(new URL(`../node_modules/${platformPackage}/bin/${LAUNCHER_BIN}`, import.meta.url))
  }
}

/**
 * The launcher grant arguments for one set of filesystem grants — everything
 * before the `--` argv separator. A caller spawns
 * `[launcherPath(), ...grantArgs(grants), '--', ...command]`; the flag
 * spellings stay private to this package.
 * @param grants - the read-only and read-write roots to allow.
 * @returns the `--ro <path>` / `--rw <path>` argument list, read-only roots
 *   first, in the caller's order.
 */
export function grantArgs(grants: LauncherGrants): string[] {
  return [
    ...(grants.readOnly ?? []).flatMap(root => ['--ro', root]),
    ...(grants.readWrite ?? []).flatMap(root => ['--rw', root]),
  ]
}

/**
 * Functional probe: `landlock-run --probe` builds and enforces a maximal
 * ruleset in a short-lived child and exits 0 only when the running kernel
 * actually enforces it — `--version`-style checks would miss a kernel that
 * has the syscalls but refuses enforcement. The probe's one report line is
 * part of the CLI contract and distinguishes complete from per-ABI-subset
 * enforcement; a zero exit without the partial marker reads as `full`. A
 * failed or timed-out spawn (missing binary, wrong architecture, unenforcing
 * kernel) probes `unusable`. Synchronous by design: consumers run it once
 * and cache the verdict.
 * @param launcher - the launcher path to probe; defaults to
 *   {@link launcherPath}'s resolution for this host.
 * @param options - `timeoutMs` bounds the probe child (default 2000).
 * @returns the enforcement verdict for this host.
 */
export function probe(
  launcher: string = launcherPath(),
  options: { timeoutMs?: number } = {},
): LandlockEnforcement {
  const result = spawnSync(launcher, ['--probe'], {
    timeout: options.timeoutMs ?? 2000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0) return 'unusable'
  return /partially enforced/.test(result.stdout) ? 'partial' : 'full'
}
