import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPlatformBinaries } from '../scripts/repo.mjs';

test('the real Landlock subpath imports without platform packages or dlopen, while the root is unexported', { timeout: 120_000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-landlock-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }), { timeout: 120_000 });
  const entry = fileURLToPath(new URL('../packages/entry/', import.meta.url));
  const installed = path.join(dir, 'node_modules', '@deepseek-ai', 'node-addon-system');
  fs.mkdirSync(installed, { recursive: true });
  fs.copyFileSync(path.join(entry, 'package.json'), path.join(installed, 'package.json'));
  // Only the real entry payload is present; no platform package or addon is copied.
  fs.cpSync(path.join(entry, 'lib'), path.join(installed, 'lib'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.types, undefined);

  const result = spawnSync(process.execPath, ['--no-addons', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const originalDlopen = process.dlopen;
    let dlopenCalls = 0;
    try {
      process.dlopen = () => {
        dlopenCalls++;
        throw new Error('Landlock import attempted dlopen');
      };
      const api = await import('@deepseek-ai/node-addon-system/landlock-run');
      assert.equal(api.LAUNCHER_BIN, 'landlock-run');
      assert.deepEqual(api.grantArgs({}), []);
      assert.equal(dlopenCalls, 0);
      await assert.rejects(import('@deepseek-ai/node-addon-system'), {
        code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      });
      assert.throws(() => createRequire(import.meta.url).resolve('@deepseek-ai/node-addon-system'), {
        code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      });
    } finally {
      process.dlopen = originalDlopen;
    }
  `], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|^NODE_PATH$/i.test(key))),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

// These minimal headers exercise format rejection, not executable behavior.
// flock.test.js and packed-install verification execute the real addon.
function fixture(t, { platform = 'linux', arch = 'x64', kind = 'node-api' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = kind === 'static-musl';
  const binary = executable
    ? { tool: 'landlock-run', kind, path: 'bin/landlock-run' }
    : { tool: 'flock', kind, napi: 8, ...(platform === 'linux' ? { libc: 'glibc' } : {}), path: 'bin/system.node' };
  const spec = { platform: `${platform}-${arch}`, binaries: [binary] };
  const manifest = { name: 'fixture', os: [platform], cpu: [arch] };
  const bytes = Buffer.alloc(256);
  if (platform === 'linux') {
    bytes.writeUInt32LE(0x464c457f, 0);
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(executable ? 2 : 3, 16);
    bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
    bytes.writeUInt32LE(8, 12);
  }
  bytes.write('napi_register_module_v1\0node_api_module_get_api_version_v1', 64);
  const file = path.join(dir, binary.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: executable ? 0o755 : 0o644 });
  const save = () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'prebuilds.json'), JSON.stringify(spec));
  };
  save();
  return { dir, file, bytes, binary, spec, manifest, save };
}

for (const platform of ['linux', 'darwin']) {
  for (const arch of ['x64', 'arm64']) {
    test(`accepts ${platform}-${arch} addon metadata and header`, (t) => {
      assert.equal(verifyPlatformBinaries(fixture(t, { platform, arch }).dir).count, 1);
    });
  }
}

test('accepts the Linux static launcher format', (t) => {
  assert.equal(verifyPlatformBinaries(fixture(t, { kind: 'static-musl' }).dir).count, 1);
});

for (const [name, change, expected] of [
  ['unknown platform', (f) => { f.manifest.os = ['win32']; }, /os\/cpu/],
  ['mismatched platform', (f) => { f.spec.platform = 'linux-arm64'; }, /disagrees/],
  ['path outside bin', (f) => { f.binary.path = '../system.node'; }, /inside bin/],
  ['duplicate binary', (f) => { f.spec.binaries.push({ ...f.binary }); }, /duplicate/],
  ['unknown kind', (f) => { f.binary.kind = 'unknown'; }, /kind\/tool\/NAPI/],
  ['wrong NAPI version', (f) => { f.binary.napi = 9; }, /kind\/tool\/NAPI/],
  ['missing Linux libc', (f) => { delete f.binary.libc; }, /declare glibc or musl/],
  ['missing payload', (f) => { fs.unlinkSync(f.file); }, /missing/],
  ['wrong ELF architecture', (f) => { f.bytes.writeUInt16LE(183, 18); fs.writeFileSync(f.file, f.bytes); }, /ELF architecture/],
  ['wrong ELF type', (f) => { f.bytes.writeUInt16LE(2, 16); fs.writeFileSync(f.file, f.bytes); }, /ELF file type/],
  ['truncated ELF', (f) => { fs.writeFileSync(f.file, Buffer.alloc(8)); }, /ELF64/],
  ['missing NAPI exports', (f) => { f.bytes.fill(0, 64); fs.writeFileSync(f.file, f.bytes); }, /Node-API entry points/],
  ['undeclared nested file', (f) => { fs.mkdirSync(path.join(f.dir, 'bin/extra')); fs.writeFileSync(path.join(f.dir, 'bin/extra/other.node'), 'x'); }, /undeclared/],
]) {
  test(`rejects ${name}`, (t) => {
    const f = fixture(t);
    change(f);
    f.save();
    assert.throws(() => verifyPlatformBinaries(f.dir), expected);
  });
}

test('rejects Linux libc metadata on macOS', (t) => {
  const f = fixture(t, { platform: 'darwin' });
  f.binary.libc = 'musl';
  f.save();
  assert.throws(() => verifyPlatformBinaries(f.dir), /must not declare/);
});

for (const [offset, value] of [[0, 0], [4, 0], [12, 2]]) {
  test(`rejects invalid Mach-O field at ${offset}`, (t) => {
    const f = fixture(t, { platform: 'darwin' });
    f.bytes.writeUInt32LE(value, offset);
    fs.writeFileSync(f.file, f.bytes);
    assert.throws(() => verifyPlatformBinaries(f.dir), /Mach-O/);
  });
}

test('rejects a launcher whose executable bit was lost', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t, { kind: 'static-musl' });
  fs.chmodSync(f.file, 0o644);
  assert.throws(() => verifyPlatformBinaries(f.dir), /not executable/);
});

test('rejects a symbolic-link payload', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  fs.renameSync(f.file, f.file + '.target');
  fs.symlinkSync(f.file + '.target', f.file);
  assert.throws(() => verifyPlatformBinaries(f.dir), /not a regular file/);
});

test('entry prepack rejects a missing exported flock file even when the Landlock entry exists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'entry-fixture',
    exports: {
      './landlock-run': { types: './lib/index.d.ts', default: './lib/index.js' },
      './flock': { types: './lib/flock.d.ts', default: './lib/flock.js' },
    },
  }));
  for (const file of ['index.js', 'index.d.ts', 'flock.d.ts']) fs.writeFileSync(path.join(dir, 'lib', file), '');
  const script = fileURLToPath(new URL('../scripts/verify-entry-lib.mjs', import.meta.url));
  const options = {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key))),
  };
  const missing = spawnSync(process.execPath, [script], options);
  assert.equal(missing.error, undefined);
  assert.equal(missing.signal, null);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /lib\/flock\.js/);
  fs.writeFileSync(path.join(dir, 'lib/flock.js'), '');
  const complete = spawnSync(process.execPath, [script], options);
  assert.equal(complete.error, undefined);
  assert.equal(complete.signal, null);
  assert.equal(complete.status, 0, complete.stderr);
});
