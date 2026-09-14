#!/usr/bin/env node
/**
 * Publish the packed launcher family from the tarballs `pack-release.mjs`
 * produced, in `publish-order.txt` order.
 *
 * What goes out is decided per package against the registry, never from the
 * order file alone: a version the registry lacks is published, a version whose
 * published tarball has the same integrity is skipped, and a version whose
 * published tarball differs fails the run — that last case means the content
 * changed without a version bump. Skipping on identical integrity is what makes
 * re-running the publish step over the same artifact safe. Without the
 * integrity skip, a partial publication has no way forward: republishing an
 * existing version fails permanently.
 *
 * Usage: `node scripts/publish-release.mjs [packed dir]`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { root } from './repo.mjs';

/**
 * Registry codes that answer a write which did not settle, rather than a
 * rejection of what was sent. `E409 Failed to save packument` is the one this
 * sequence actually hits: publishing the platform packages and the entry back
 * to back can outrun the registry's own processing. A rejected payload (`E403`
 * over an existing version, a malformed manifest) never clears on a retry.
 */
const TRANSIENT_PUBLISH_CODES = ['E409', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'];

/** How many times one tarball's publish is attempted before the run fails. */
const PUBLISH_ATTEMPTS = 4;

/**
 * Shortest gap between two publishes, and the first retry backoff. The registry
 * needs a moment to commit a packument before the next write; back to back
 * publishes are what produce `E409`.
 */
const PUBLISH_SPACING_MS = 2_000;

const destination = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || path.join(root, 'dist', 'npm'));

/**
 * @param {string} output Combined npm output.
 * @returns {boolean} True when the registry reported a write it did not commit.
 */
function isTransientFailure(output) {
  return TRANSIENT_PUBLISH_CODES.some((code) => output.includes(`code ${code}`));
}

/**
 * @param {string} tarball Absolute tarball path.
 * @returns {string} The `sha512-<base64>` integrity npm records for it.
 */
function integrityOf(tarball) {
  return `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
}

/**
 * @param {string} tarball Absolute tarball path.
 * @returns {{name: string, version: string}} What the packed manifest declares.
 */
function packedIdentity(tarball) {
  const result = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot read the manifest inside ${tarball}:\n${result.stderr}`);
  const manifest = JSON.parse(result.stdout);
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`${tarball} manifest lacks name/version`);
  }
  return { name: manifest.name, version: manifest.version };
}

/**
 * Ask the registry whether a version exists, and with what integrity.
 * @param {string} name Package name.
 * @param {string} version Package version.
 * @returns {{kind: 'absent'} | {kind: 'present', integrity: string}} Registry state.
 */
function registryState(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'dist.integrity', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`;
    if (output.includes('E404') || output.includes('404 Not Found')) return { kind: 'absent' };
    throw new Error(`npm view ${name}@${version} failed:\n${output}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed !== 'string' || parsed === '') {
    throw new Error(`registry reported no dist.integrity for ${name}@${version}`);
  }
  return { kind: 'present', integrity: parsed };
}

/**
 * Publish one tarball, retrying a registry write that did not settle.
 *
 * Every retry re-reads the registry first, because `E409` can answer a write
 * that landed anyway: republishing a version that now exists fails permanently,
 * so the same integrity appearing under the failed attempt counts as success.
 * @param {string} tarball Absolute tarball path.
 * @param {string} name Package name the tarball declares.
 * @param {string} version Package version the tarball declares.
 */
async function publishTarball(tarball, name, version) {
  // A prerelease version never takes the latest dist-tag.
  const tagArgs = version.includes('-') ? ['--tag', 'next'] : [];
  for (let tries = 1; tries <= PUBLISH_ATTEMPTS; tries += 1) {
    // No --access: publishConfig.access in each manifest decides, and a
    // command-line flag would override it.
    const result = spawnSync('npm', ['publish', tarball, ...tagArgs], { encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;
    if (result.status === 0) return;

    const settled = registryState(name, version);
    if (settled.kind === 'present' && settled.integrity === integrityOf(tarball)) {
      console.log(`landlock publish: ${name}@${version} landed despite a reported failure, continuing`);
      return;
    }
    if (tries === PUBLISH_ATTEMPTS || !isTransientFailure(output)) {
      throw new Error(`npm publish ${name}@${version} failed:\n${output}`);
    }
    const backoff = PUBLISH_SPACING_MS * 2 ** (tries - 1);
    console.log(
      `landlock publish: ${name}@${version} hit a transient registry failure`
      + ` (attempt ${tries} of ${PUBLISH_ATTEMPTS}), retrying in ${backoff}ms`,
    );
    await sleep(backoff);
  }
}

const order = fs
  .readFileSync(path.join(destination, 'publish-order.txt'), 'utf8')
  .split('\n')
  .filter((line) => line !== '');

let published = 0;
let skipped = 0;
for (const filename of order) {
  const tarball = path.join(destination, filename);
  const { name, version } = packedIdentity(tarball);
  const state = registryState(name, version);
  if (state.kind === 'present') {
    const local = integrityOf(tarball);
    if (state.integrity !== local) {
      throw new Error(
        `${name}@${version} is already published with different content`
        + `\n  registry: ${state.integrity}\n  packed:   ${local}`
        + '\nBump the version, or investigate why the build is not reproducible.',
      );
    }
    console.log(`landlock publish: ${name}@${version} already published, skipping`);
    skipped += 1;
    continue;
  }
  // Space out the writes: the gap belongs between publishes, so a run that only
  // skips does not wait at all.
  if (published > 0) await sleep(PUBLISH_SPACING_MS);
  await publishTarball(tarball, name, version);
  console.log(`landlock publish: ${name}@${version} published`);
  published += 1;
}

console.log(`landlock publish: ${published} published, ${skipped} already present`);
