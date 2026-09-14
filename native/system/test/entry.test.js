/**
 * Keyless entry-package tests — run on every host, no kernel or binary
 * required. Cover the JavaScript API's pure surface: grant-argv construction, the
 * resolution contract (platform package → fallback), and probe verdicts over
 * fake launchers. Requires built `lib/` (`pnpm build:ts`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LAUNCHER_BIN,
  LAUNCHER_FAILURE_EXIT,
  grantArgs,
  launcherPath,
  probe,
} from '@deepseek-ai/node-addon-system/landlock-run';

await assert.rejects(import('@deepseek-ai/node-addon-system'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
});

// --- constants are part of the CLI contract ---
assert.equal(LAUNCHER_BIN, 'landlock-run');
assert.equal(LAUNCHER_FAILURE_EXIT, 125);

// --- grantArgs: flag spelling, ordering, and empty grants ---
assert.deepEqual(grantArgs({}), []);
assert.deepEqual(grantArgs({ readOnly: ['/'] }), ['--ro', '/']);
assert.deepEqual(
  grantArgs({ readOnly: ['/', '/opt'], readWrite: ['/tmp/work'] }),
  ['--ro', '/', '--ro', '/opt', '--rw', '/tmp/work'],
);
assert.deepEqual(grantArgs({ readWrite: ['/a'], readOnly: ['/b'] }), ['--ro', '/b', '--rw', '/a']);

// --- launcherPath: resolves the platform package next to its package.json ---
const platformPackage = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`;
const resolvedViaSeam = launcherPath((specifier) => {
  assert.equal(specifier, `${platformPackage}/package.json`);
  return path.join('/fake-install', specifier);
});
assert.equal(resolvedViaSeam, path.join('/fake-install', platformPackage, 'bin', LAUNCHER_BIN));

// --- launcherPath: unresolvable package falls back to an absolute, package-boundary path ---
const fallback = launcherPath(() => {
  throw new Error('not installed');
});
assert.ok(path.isAbsolute(fallback), 'fallback path must be absolute');
assert.ok(
  fallback.includes(path.join('node_modules', ...platformPackage.split('/'), 'bin', LAUNCHER_BIN)),
  `fallback must point at the platform package layout: ${fallback}`,
);

// --- launcherPath: default resolution agrees with this workspace's layout ---
const defaultPath = launcherPath();
assert.ok(path.isAbsolute(defaultPath));
assert.ok(defaultPath.endsWith(path.join('bin', LAUNCHER_BIN)), defaultPath);

// --- probe: a missing launcher is unusable, indistinguishable from an unenforcing kernel ---
assert.equal(probe(path.join(os.tmpdir(), 'nalr-no-such-launcher')), 'unusable');

// --- probe: verdict parsing over fake launchers (POSIX shells only) ---
if (process.platform !== 'win32') {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalr-fake-launcher-'));
  const fake = (name, script) => {
    const file = path.join(fakeDir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  };

  assert.equal(probe(fake('full', 'echo "landlock: fully enforced"; exit 0')), 'full');
  assert.equal(probe(fake('partial', 'echo "landlock: partially enforced (older ABI)"; exit 0')), 'partial');
  assert.equal(probe(fake('failing', `exit ${LAUNCHER_FAILURE_EXIT}`)), 'unusable');
  assert.equal(probe(fake('hanging', 'sleep 10'), { timeoutMs: 200 }), 'unusable');

  fs.rmSync(fakeDir, { recursive: true, force: true });
}

console.log('entry.test: ok');
