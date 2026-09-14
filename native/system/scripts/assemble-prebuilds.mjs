#!/usr/bin/env node
/**
 * Assemble downloaded release artifacts into the platform packages and
 * verify the result. The Release workflow's build legs upload one
 * `prebuild-<package>` artifact per platform package (its `bin/` payload);
 * this script copies each into `packages/<package>/bin/` and then checks
 * every declared binary for presence and native architecture.
 *
 * Usage: `node scripts/assemble-prebuilds.mjs <artifact-root>`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { platformDirs, root, verifyPlatformBinaries } from './repo.mjs';

const artifactRoot = path.resolve(process.argv[2] || '.release/prebuild-artifacts');

if (!fs.existsSync(artifactRoot)) {
  throw new Error(`prebuild artifact directory does not exist: ${artifactRoot}`);
}

const platforms = platformDirs().map((dir) => path.basename(dir));

for (const name of platforms) {
  const binDir = path.join(root, 'packages', name, 'bin');
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });
}

for (const artifactName of fs.readdirSync(artifactRoot)) {
  const artifactDir = path.join(artifactRoot, artifactName);
  if (!fs.statSync(artifactDir).isDirectory()) continue;

  const name = platforms.find((candidate) => artifactName === `prebuild-${candidate}`);
  if (!name) {
    throw new Error(`cannot map artifact to a platform package: ${artifactName}`);
  }

  for (const file of fs.readdirSync(artifactDir)) {
    const source = path.join(artifactDir, file);
    const destination = path.join(root, 'packages', name, 'bin', file);
    fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
    console.log(`Copied ${path.relative(root, source)} -> ${path.relative(root, destination)}`);
  }
}

for (const dir of platformDirs()) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, dir, 'prebuilds.json'), 'utf8'));
  for (const binary of metadata.binaries) {
    if (binary.kind === 'static-musl') fs.chmodSync(path.join(root, dir, binary.path), 0o755);
  }
  const { name, count } = verifyPlatformBinaries(path.join(root, dir));
  console.log(`Verified ${name}: ${count} binaries`);
}
