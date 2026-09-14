#!/usr/bin/env node
/**
 * Pack every published package into release tarballs, in publish order
 * (platform packages first, then the entries that optionally depend on
 * them), and write `publish-order.txt` next to them. `pnpm pack` produces
 * the EXACT bytes `pnpm publish` would upload and runs each package's
 * `prepack` gate, so a missing binary or unbuilt `lib/` refuses here.
 *
 * Usage: `node scripts/pack-release.mjs [dest] [--current-platform-only]`.
 * The flag packs only THIS host's platform package plus the entries — for
 * per-architecture CI legs, where the other architecture's binary does not
 * exist (the exact refusal its prepack gate exists for).
 * Workflow repository metadata is projected only into disposable pack inputs;
 * source manifests retain the public source home. See docs/packaging.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { entryDirs, platformDirs, readJson, root } from './repo.mjs';

const args = process.argv.slice(2);
const currentPlatformOnly = args.includes('--current-platform-only');
const destination = path.resolve(args.find((arg) => !arg.startsWith('--')) || path.join(root, 'dist', 'npm'));

function hostPlatformDirs() {
  const hostPlatform = `${process.platform}-${process.arch}`;
  return platformDirs().filter((dir) => readJson(path.join(root, dir, 'prebuilds.json')).platform === hostPlatform);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (status=${result.status}, signal=${result.signal})`);
  }
}

function tarballName(manifest) {
  if (manifest.name.startsWith('@')) {
    return `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`;
  }
  return `${manifest.name}-${manifest.version}.tgz`;
}

/** Repository identity npm verifies against the workflow's OIDC claims. */
function workflowRepositoryUrl() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository === undefined && process.env.GITHUB_ACTIONS !== 'true') return undefined;
  if (repository === undefined || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must identify the workflow owner/repository');
  }
  const server = new URL(process.env.GITHUB_SERVER_URL || 'https://github.com');
  if (server.protocol !== 'https:' || server.pathname !== '/' || server.search || server.hash
    || server.username || server.password) {
    throw new Error('GITHUB_SERVER_URL must be an HTTPS origin');
  }
  return `git+${server.origin}/${repository}.git`;
}

/** Copy pack inputs while keeping source manifests and completed tarballs untouched. */
function stagePackages(staging, repositoryUrl) {
  for (const directory of ['packages', 'scripts']) {
    fs.cpSync(path.join(root, directory), path.join(staging, directory), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  fs.copyFileSync(path.join(root, 'package.json'), path.join(staging, 'package.json'));
  // pnpm includes the repository workspace license when an entry has no package-local license.
  fs.copyFileSync(path.resolve(root, '../../LICENSE'), path.join(staging, 'LICENSE'));
  fs.writeFileSync(path.join(staging, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  for (const dir of [...platformDirs(), ...entryDirs()]) {
    const manifestPath = path.join(staging, dir, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.repository = { ...manifest.repository, url: repositoryUrl };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

const repositoryUrl = workflowRepositoryUrl();
const staging = repositoryUrl === undefined ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'native-system-pack-'));
try {
  if (staging !== undefined) stagePackages(staging, repositoryUrl);
  const packRoot = staging ?? root;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  const dirs = [...(currentPlatformOnly ? hostPlatformDirs() : platformDirs()), ...entryDirs()];
  const platformSet = new Set(platformDirs());
  const publishOrder = [];
  for (const dir of dirs) {
    const manifest = readJson(path.join(root, dir, 'package.json'));
    // Platform packages are packed with npm: pnpm pack (observed on 11.7.0)
    // normalizes file modes and STRIPS the executable bit, which ships a
    // launcher no consumer can spawn; npm pack preserves it. Platform packages
    // have no dependencies by construction, so they need none of pnpm's
    // workspace-protocol conversion — the entry packages do, and carry no
    // executables, so they keep pnpm pack.
    if (platformSet.has(dir)) {
      run('npm', ['pack', `./${dir}`, '--pack-destination', destination], packRoot);
    } else {
      run('pnpm', ['--dir', dir, 'pack', '--pack-destination', destination], packRoot);
    }

    const tarball = tarballName(manifest);
    const tarballPath = path.join(destination, tarball);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`expected pack output not found: ${tarballPath}`);
    }
    publishOrder.push(tarball);
  }

  fs.writeFileSync(path.join(destination, 'publish-order.txt'), `${publishOrder.join('\n')}\n`);
  console.log(`Packed ${publishOrder.length} packages into ${path.relative(root, destination)}`);
} finally {
  if (staging !== undefined) fs.rmSync(staging, { recursive: true, force: true });
}
