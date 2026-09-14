import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const publicRepository = 'git+https://github.com/deepseek-ai/deepseek-harness.git';
const workspaceLicense = 'Fixture workspace license.\n';

/** Real packing uses the repository's nested workspace layout and isolated, format-valid payloads. */
function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'native-packing-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const dir = path.join(workspace, 'native/system');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), `${JSON.stringify({ private: true, packageManager: 'pnpm@11.7.0' })}\n`);
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - native/system\n  - native/system/packages/*\n');
  fs.writeFileSync(path.join(workspace, 'LICENSE'), workspaceLicense);
  const scratch = path.join(workspace, 'scratch');
  fs.mkdirSync(scratch);
  fs.cpSync(fileURLToPath(new URL('../scripts/', import.meta.url)), path.join(dir, 'scripts'), { recursive: true });
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
  };
  const repository = (name) => ({ type: 'git', url: publicRepository, directory: `native/system/packages/${name}` });
  writeJson('package.json', { name: 'native-packing-fixture', private: true, version: '1.2.3', packageManager: 'pnpm@11.7.0' });
  writeJson('packages/linux-x64/package.json', {
    name: '@fixture/native-linux-x64', version: '1.2.3', repository: repository('linux-x64'),
    os: ['linux'], cpu: ['x64'], files: ['bin/', 'prebuilds.json'],
    scripts: { prepack: 'node ../../scripts/verify-launcher-binary.mjs' },
  });
  writeJson('packages/linux-x64/prebuilds.json', {
    platform: 'linux-x64', binaries: [{ tool: 'landlock-run', kind: 'static-musl', path: 'bin/landlock-run' }],
  });
  const binary = Buffer.alloc(64);
  binary.writeUInt32LE(0x464c457f, 0);
  binary[4] = 2;
  binary[5] = 1;
  binary.writeUInt16LE(2, 16);
  binary.writeUInt16LE(62, 18);
  fs.mkdirSync(path.join(dir, 'packages/linux-x64/bin'));
  fs.writeFileSync(path.join(dir, 'packages/linux-x64/bin/landlock-run'), binary, { mode: 0o755 });
  writeJson('packages/entry/package.json', {
    name: '@fixture/native', version: '1.2.3', type: 'module', repository: repository('entry'),
    exports: { '.': './lib/index.js' }, files: ['lib/'],
    optionalDependencies: { '@fixture/native-linux-x64': 'workspace:*' },
    scripts: { prepack: 'node ../../scripts/verify-entry-lib.mjs' },
  });
  fs.mkdirSync(path.join(dir, 'packages/entry/lib'));
  fs.writeFileSync(path.join(dir, 'packages/entry/lib/index.js'), 'export const packed = true;\n');
  fs.mkdirSync(path.join(dir, 'packages/entry/node_modules/@fixture'), { recursive: true });
  fs.symlinkSync('../../../linux-x64', path.join(dir, 'packages/entry/node_modules/@fixture/native-linux-x64'), 'junction');
  const manifests = ['package.json', 'packages/entry/package.json', 'packages/linux-x64/package.json'];
  const original = manifests.map(file => fs.readFileSync(path.join(dir, file), 'utf8'));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|^GITHUB_|^NODE_PATH$/i.test(key)));
  Object.assign(env, { TMPDIR: scratch, TMP: scratch, TEMP: scratch, npm_config_cache: path.join(dir, 'npm-cache') });
  return {
    dir, binary,
    pack: (extra = {}) => spawnSync(process.execPath, ['scripts/pack-release.mjs', 'output'], {
      cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000,
    }),
    unchanged() {
      assert.deepEqual(manifests.map(file => fs.readFileSync(path.join(dir, file), 'utf8')), original);
      assert.equal(fs.readFileSync(path.join(workspace, 'LICENSE'), 'utf8'), workspaceLicense);
      assert.deepEqual(fs.readdirSync(scratch).filter(name => name.startsWith('native-system-pack-')), []);
    },
  };
}

function completed(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function tarFile(dir, tarball, file) {
  const result = spawnSync('tar', ['-xOf', path.join(dir, 'output', tarball), `package/${file}`], {
    timeout: 120_000,
  });
  completed(result);
  return result.stdout;
}

for (const workflow of [false, true]) {
  test(`packing ${workflow ? 'workflow' : 'local'} artifacts preserves source manifests and native payloads`, { timeout: 180_000 }, (t) => {
    const f = fixture(t);
    const result = f.pack(workflow ? {
      GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'fixture-owner/native-runtime', GITHUB_SERVER_URL: 'https://github.example.com',
    } : {});
    completed(result);
    f.unchanged();
    const files = fs.readFileSync(path.join(f.dir, 'output/publish-order.txt'), 'utf8').trim().split('\n');
    assert.deepEqual(files, ['fixture-native-linux-x64-1.2.3.tgz', 'fixture-native-1.2.3.tgz']);
    const manifests = files.map(file => JSON.parse(tarFile(f.dir, file, 'package.json')));
    for (const manifest of manifests) {
      assert.equal(manifest.repository.url, workflow ? 'git+https://github.example.com/fixture-owner/native-runtime.git' : publicRepository);
      assert.equal(manifest.repository.type, 'git');
    }
    assert.equal(manifests[0].repository.directory, 'native/system/packages/linux-x64');
    assert.equal(manifests[1].repository.directory, 'native/system/packages/entry');
    assert.equal(manifests[1].optionalDependencies['@fixture/native-linux-x64'], '1.2.3');
    assert.equal(tarFile(f.dir, files[1], 'LICENSE').toString(), workspaceLicense);
    assert.deepEqual(tarFile(f.dir, files[0], 'bin/landlock-run'), f.binary);
    const extracted = path.join(f.dir, 'extracted');
    fs.mkdirSync(extracted);
    completed(spawnSync('tar', ['-xzf', path.join(f.dir, 'output', files[0]), '-C', extracted], { timeout: 120_000 }));
    if (process.platform !== 'win32') assert.notEqual(fs.statSync(path.join(extracted, 'package/bin/landlock-run')).mode & 0o111, 0);
  });
}

test('a package-local license takes precedence over the workspace license during workflow packing', { timeout: 180_000 }, (t) => {
  const f = fixture(t);
  const entryLicense = 'Fixture entry license.\n';
  fs.writeFileSync(path.join(f.dir, 'packages/entry/LICENSE'), entryLicense);
  completed(f.pack({ GITHUB_REPOSITORY: 'fixture-owner/native-runtime' }));
  assert.equal(tarFile(f.dir, 'fixture-native-1.2.3.tgz', 'LICENSE').toString(), entryLicense);
  assert.equal(fs.readFileSync(path.join(f.dir, 'packages/entry/LICENSE'), 'utf8'), entryLicense);
  f.unchanged();
});

test('invalid workflow identity fails before deleting existing pack output', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'output'));
  fs.writeFileSync(path.join(f.dir, 'output/retained'), 'previous artifact');
  for (const env of [{ GITHUB_ACTIONS: 'true' }, { GITHUB_REPOSITORY: 'owner/repo/extra' }, {
    GITHUB_REPOSITORY: 'owner/repo', GITHUB_SERVER_URL: 'https://github.example.com/path',
  }]) {
    const result = f.pack(env);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GITHUB_(?:REPOSITORY|SERVER_URL)/);
    assert.equal(fs.readFileSync(path.join(f.dir, 'output/retained'), 'utf8'), 'previous artifact');
    f.unchanged();
  }
});

test('a prepack rejection cleans staging and leaves source manifests unchanged', { timeout: 180_000 }, (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.dir, 'packages/linux-x64/bin/landlock-run'));
  const result = f.pack({ GITHUB_REPOSITORY: 'fixture-owner/native-runtime' });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing bin\/landlock-run/);
  f.unchanged();
});
