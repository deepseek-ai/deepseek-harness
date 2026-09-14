#!/usr/bin/env node
/**
 * Bump, stage, and commit a release in one command:
 * `pnpm release:commit <major|minor|patch|x.y.z>`. The namespaced tag stays
 * manual — create it from the merged release commit.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageDirs, readJson, root } from './repo.mjs';

const bump = process.argv[2];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!bump) {
  console.error('Usage: pnpm release:commit <major|minor|patch|x.y.z>');
  process.exit(1);
}

run('node', ['./scripts/bump-release.mjs', bump]);

const version = readJson(path.join(root, packageDirs()[0], 'package.json')).version;
run('git', [
  'add',
  'package.json',
  'packages/*/package.json',
  '../../pnpm-lock.yaml',
]);
run('git', ['commit', '-m', `release(node-addon-system): ${version}`]);

console.log(`Committed release ${version}. Create the tag manually: git tag node-addon-system-v${version}`);
