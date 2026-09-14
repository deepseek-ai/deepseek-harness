#!/usr/bin/env node
/**
 * Derive the GitHub Actions matrices from the checked-in package matrix
 * (`packages/<name>/prebuilds.json`). Single source: adding a platform
 * package extends CI and Release without editing a workflow.
 *
 *   node scripts/github-matrix.mjs ci                → one leg per distinct platform
 *   node scripts/github-matrix.mjs release-prebuild  → one leg per platform package
 */

import path from 'node:path';
import { platformDirs, readJson, root } from './repo.mjs';

/** GitHub runner per prebuilds.json `platform` value — native builders only, no cross toolchain. */
const RUNNERS = {
  'linux-x64': 'ubuntu-24.04',
  'linux-arm64': 'ubuntu-24.04-arm',
  'darwin-x64': 'macos-15-intel',
  'darwin-arm64': 'macos-latest',
};

function runnerFor(platform) {
  const runner = RUNNERS[platform];
  if (!runner) {
    throw new Error(`missing GitHub runner for platform: ${platform}`);
  }
  return runner;
}

function platformManifests() {
  return platformDirs().map((dir) => ({
    dir,
    name: path.basename(dir),
    prebuilds: readJson(path.join(root, dir, 'prebuilds.json')),
  }));
}

function ciMatrix() {
  const platforms = [...new Set(platformManifests().map(({ prebuilds }) => prebuilds.platform))].sort();
  return {
    include: platforms.map((platform) => ({ platform, runner: runnerFor(platform) })),
  };
}

function releasePrebuildMatrix() {
  return {
    include: platformManifests().map(({ dir, name, prebuilds }) => ({
      platform: prebuilds.platform,
      package: name,
      dir,
      runner: runnerFor(prebuilds.platform),
      artifact: `prebuild-${name}`,
    })),
  };
}

const target = process.argv[2];
const matrices = {
  ci: ciMatrix,
  'release-prebuild': releasePrebuildMatrix,
  compatibility: () => ciMatrix().include.flatMap((row) => [20, 22, 24, 26].map((node) => ({ ...row, node }))),
};

if (!target || !matrices[target]) {
  console.error(`Usage: node scripts/github-matrix.mjs <${Object.keys(matrices).join('|')}>`);
  process.exit(1);
}

process.stdout.write(JSON.stringify(matrices[target]()));
