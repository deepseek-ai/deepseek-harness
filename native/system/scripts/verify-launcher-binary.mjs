#!/usr/bin/env node
/**
 * Prepack gate for platform packages: refuse to pack a tarball whose
 * declared binaries are missing or built for the wrong architecture.
 *
 * Without it, `pnpm pack` on a checkout that never ran
 * `pnpm run build:native` would ship an EMPTY platform package — the
 * binary's absence surfacing only at runtime as a failed probe on every
 * consumer — and a binary copied across packages would advertise an
 * architecture it cannot execute. Checks cover ELF/Mach-O format, architecture,
 * declared payloads, and Node-API exports. `verify-packed-install.mjs`
 * separately pins the installed tarball bytes to the workspace build.
 *
 * Runs from each platform package's `prepack` hook (pnpm sets the script
 * cwd to the package directory). Also callable directly with an explicit
 * package directory: `node scripts/verify-launcher-binary.mjs packages/<name>`.
 */

import path from 'node:path';
import { root, verifyPlatformBinaries } from './repo.mjs';

const packageDir = process.argv[2] ? path.resolve(root, process.argv[2]) : process.cwd();

try {
  const { name, count } = verifyPlatformBinaries(packageDir);
  console.log(`verify-launcher-binary: ${name} — ${count} binaries present with the right native format and architecture.`);
} catch (error) {
  console.error(`verify-launcher-binary: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
