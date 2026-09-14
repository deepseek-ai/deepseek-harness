#!/usr/bin/env node
/**
 * Publish-path rehearsal without publishing: verify the packed tarballs are
 * exactly what a consumer install needs. `pnpm pack` already produced the
 * bytes `pnpm publish` would upload; this script checks the payload
 * (coverage, concrete dependency versions, NO lifecycle install scripts —
 * this family has no install fallback on purpose), installs the entry plus
 * THIS host's platform tarball into a throwaway consumer OUTSIDE the repo,
 * byte-pins the installed binary against the workspace build it was packed
 * from, and drives the INSTALLED entry under plain `node` — resolution,
 * probe, and a real confinement world-proof through the installed launcher.
 *
 * On non-Linux hosts it proves that Landlock remains unavailable, while
 * supported POSIX hosts independently exercise the flock binding.
 *
 * Usage: `node scripts/verify-packed-install.mjs [tarball-dir] [--current-platform-only]`.
 * The flag skips the all-platforms tarball-presence check for
 * per-architecture CI legs. `NALR_REQUIRE_LANDLOCK=1` makes an unenforcing
 * kernel a failure instead of a skipped world-proof (set on CI, where the
 * kernel is known).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { entryDirs, packageDirs, platformDirs, readJson, root } from './repo.mjs';

const args = process.argv.slice(2);
const currentPlatformOnly = args.includes('--current-platform-only');
const tarballDir = path.resolve(args.find((arg) => !arg.startsWith('--')) || path.join(root, 'dist', 'npm'));
const entryPackageName = '@deepseek-ai/node-addon-system';

function tarballName(manifest) {
  if (manifest.name.startsWith('@')) {
    return `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`;
  }
  return `${manifest.name}-${manifest.version}.tgz`;
}

function tarballPath(manifest) {
  const tarball = path.join(tarballDir, tarballName(manifest));
  if (!fs.existsSync(tarball)) {
    throw new Error(`missing packed tarball: ${tarball}`);
  }
  return tarball;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (status=${result.status}, signal=${result.signal})`);
  }
}

function runCapture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function readPackedManifest(manifest) {
  return JSON.parse(runCapture('tar', ['-xOf', tarballPath(manifest), 'package/package.json']));
}

function verifyPackedManifest(packed) {
  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare'];
  for (const script of lifecycle) {
    if (packed.scripts?.[script]) {
      throw new Error(`${packed.name}: packed manifest carries a "${script}" lifecycle script — this family has no install fallback`);
    }
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(packed[field] ?? {})) {
      if (version.includes('workspace:')) {
        throw new Error(`${packed.name}: packed ${field} still uses the workspace protocol: ${name}@${version}`);
      }
    }
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function packageInstallDir(packageName) {
  return path.join(tempRoot, 'node_modules', ...packageName.split('/'));
}

const manifests = packageDirs().map((dir) => ({ dir, manifest: readJson(path.join(root, dir, 'package.json')) }));
const entryManifest = manifests.find(({ manifest }) => manifest.name === entryPackageName)?.manifest;
if (!entryManifest) throw new Error(`missing source manifest for ${entryPackageName}`);

const hostPlatform = `${process.platform}-${process.arch}`;
const currentPlatformEntry = manifests.find(
  ({ dir, manifest }) => platformDirs().includes(dir) && manifest.name === `${entryPackageName}-${hostPlatform}`,
);

// Payload checks: every expected tarball exists (full mode), the packed
// entry's optional-dependency set names exactly the platform packages, and
// no packed manifest carries workspace versions or install lifecycle.
const expectedTarballs = currentPlatformOnly
  ? manifests.filter(({ dir }) => entryDirs().includes(dir) || dir === currentPlatformEntry?.dir)
  : manifests;
for (const { manifest } of expectedTarballs) {
  tarballPath(manifest);
}

const packedEntry = readPackedManifest(entryManifest);
const platformPackageNames = manifests
  .filter(({ dir }) => platformDirs().includes(dir))
  .map(({ manifest }) => manifest.name)
  .sort();
const optionalNames = Object.keys(packedEntry.optionalDependencies || {}).sort();
if (optionalNames.join('\n') !== platformPackageNames.join('\n')) {
  throw new Error(`packed entry optionalDependencies mismatch\nactual:\n${optionalNames.join('\n')}\nexpected:\n${platformPackageNames.join('\n')}`);
}
for (const { manifest } of expectedTarballs) {
  verifyPackedManifest(readPackedManifest(manifest));
}

// Throwaway ESM consumer, built from local tarballs only — no registry.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-system-packed-'));
try {
fs.writeFileSync(
  path.join(tempRoot, 'package.json'),
  `${JSON.stringify({ name: 'native-system-packed-check', version: '0.0.0', private: true, type: 'module', dependencies: Object.fromEntries([entryManifest, ...(currentPlatformEntry ? [currentPlatformEntry.manifest] : [])].map((manifest) => [manifest.name, `file:${tarballPath(manifest)}`])) }, null, 2)}\n`,
);
console.log(`Verifying packed install in ${tempRoot}`);

run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: tempRoot });
if (currentPlatformEntry) {

  // Byte-pin: the installed binary must be the workspace build it was packed
  // from — any divergence means the tarball did not carry the built bytes.
  const prebuilds = readJson(path.join(root, currentPlatformEntry.dir, 'prebuilds.json'));
  for (const binary of prebuilds.binaries) {
    const workspaceFile = path.join(root, currentPlatformEntry.dir, binary.path);
    const installedFile = path.join(packageInstallDir(currentPlatformEntry.manifest.name), binary.path);
    if (sha256(workspaceFile) !== sha256(installedFile)) {
      throw new Error(`installed ${binary.path} differs from the workspace build it was packed from`);
    }
    console.log(`Byte-pinned ${binary.path} against the workspace build`);
  }
} else if (process.platform === 'linux') {
  throw new Error(`linux host without a platform package in the matrix: ${hostPlatform}`);
}

// Drive the INSTALLED entry under plain node: resolution, probe, and (on an
// enforcing kernel) a real confinement world-proof through the installed
// launcher.
const driver = path.join(tempRoot, 'driver.mjs');
fs.writeFileSync(driver, `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grantArgs, launcherPath, probe } from '@deepseek-ai/node-addon-system/landlock-run';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';

await assert.rejects(import('@deepseek-ai/node-addon-system'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
});

const requireLandlock = process.env.NALR_REQUIRE_LANDLOCK === '1';
const platformPackage = '@deepseek-ai/node-addon-system-' + process.platform + '-' + process.arch;
const resolved = launcherPath();
assert.ok(path.isAbsolute(resolved), 'launcherPath must be absolute');
assert.ok(resolved.includes(path.join(...platformPackage.split('/'))), 'launcherPath must point into the platform package: ' + resolved);

if (process.platform === 'linux') {
  assert.ok(fs.existsSync(resolved), 'installed launcher missing at ' + resolved);
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    throw new Error('installed launcher is not executable — the pack path stripped the mode bit: ' + resolved);
  }
  const enforcement = probe(resolved);
  console.log('probe through the installed launcher: ' + enforcement);
  if (enforcement === 'unusable') {
    if (requireLandlock) throw new Error('NALR_REQUIRE_LANDLOCK=1 but the probe reports unusable');
    console.log('kernel does not enforce Landlock — skipping the confinement world-proof');
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nalr-confine-'));
    const denied = path.join(work, 'denied.txt');
    const deniedRun = spawnSync(resolved, [...grantArgs({ readOnly: ['/'] }), '--', '/bin/sh', '-c', 'echo x > ' + denied], { encoding: 'utf8' });
    assert.notEqual(deniedRun.status, 0, 'write outside the grants must fail');
    assert.ok(!fs.existsSync(denied), 'denied write must not land on disk');
    const granted = path.join(work, 'granted.txt');
    const grantedRun = spawnSync(resolved, [...grantArgs({ readOnly: ['/'], readWrite: [work] }), '--', '/bin/sh', '-c', 'echo ok > ' + granted], { encoding: 'utf8' });
    assert.equal(grantedRun.status, 0, 'granted write must succeed: ' + grantedRun.stderr);
    assert.equal(fs.readFileSync(granted, 'utf8').trim(), 'ok');
    console.log('confinement world-proof passed through the installed launcher');
  }
} else {
  assert.ok(!fs.existsSync(resolved), 'Landlock has no executable for this host');
  assert.equal(probe(resolved), 'unusable');
  console.log('non-linux host: fallback resolution and unusable probe verified');
}

if (process.platform === 'linux' || process.platform === 'darwin') {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-system-flock-'));
  const handles = [];
  try {
    const lock = path.join(lockRoot, 'lock');
    const a = fs.openSync(lock, 'wx+', 0o600);
    handles.push(a);
    const b = fs.openSync(lock, 'r+');
    handles.push(b);
    await tryLockExclusive(a);
    await assert.rejects(tryLockExclusive(b), { code: 'EAGAIN' });
    fs.closeSync(a);
    handles.splice(handles.indexOf(a), 1);
    await tryLockExclusive(b);
    console.log('installed Node-API flock: exclusion and close release verified');
  } finally {
    for (const fd of handles) fs.closeSync(fd);
    fs.rmSync(lockRoot, { recursive: true, force: true });
  }
}
`);
run(process.execPath, [driver], { cwd: tempRoot });

console.log('Packed install verification passed.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
