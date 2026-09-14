#!/usr/bin/env node
/**
 * Shared helpers for the repo scripts: package discovery, the checked-in
 * prebuild matrix, and binary verification. The package matrix is explicit
 * metadata — `packages/<name>/prebuilds.json` marks a platform package and
 * declares its binaries; everything else under `packages/` is an entry
 * package. Scripts derive from these files and never guess.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
const packagesRoot = path.join(root, 'packages');

/** ELF `e_machine` (offset 18, little-endian) per platform-package `cpu` value. */
const E_MACHINE = { x64: 62, arm64: 183 };

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Platform packages: every `packages/<name>` carrying a `prebuilds.json`. */
export function platformDirs() {
  return fs.readdirSync(packagesRoot)
    .filter((name) => fs.existsSync(path.join(packagesRoot, name, 'prebuilds.json')))
    .sort()
    .map((name) => path.join('packages', name));
}

/** Entry packages: every other `packages/<name>` with a `package.json`. */
export function entryDirs() {
  return fs.readdirSync(packagesRoot)
    .filter((name) => !fs.existsSync(path.join(packagesRoot, name, 'prebuilds.json')))
    .filter((name) => fs.existsSync(path.join(packagesRoot, name, 'package.json')))
    .sort()
    .map((name) => path.join('packages', name));
}

/** All published packages in publish order: platform packages before the entries that optionally depend on them. */
export function packageDirs() {
  return [...platformDirs(), ...entryDirs()];
}

/**
 * Verify platform metadata, complete bin/ payloads, executable permissions,
 * and native file formats before packing. Node addons must export Node-API.
 */
export function verifyPlatformBinaries(packageDir) {
  const manifest = readJson(path.join(packageDir, 'package.json'));
  const prebuilds = readJson(path.join(packageDir, 'prebuilds.json'));
  const cpu = manifest.cpu?.[0];
  const os = manifest.os?.[0];
  if (!(cpu in E_MACHINE) || !['linux', 'darwin'].includes(os)) {
    throw new Error(`${manifest.name}: unsupported or missing os/cpu metadata`);
  }
  if (prebuilds.platform !== `${os}-${cpu}`) {
    throw new Error(`${manifest.name}: prebuild platform disagrees with package os/cpu`);
  }

  const declared = new Set();
  for (const binary of prebuilds.binaries) {
    if (typeof binary.path !== 'string' || !/^bin\/(?:[a-z0-9-]+\/)?[a-z0-9._-]+$/.test(binary.path)) {
      throw new Error(`${manifest.name}: binary path must name a file inside bin/`);
    }
    if (declared.has(binary.path)) throw new Error(`${manifest.name}: duplicate binary path ${binary.path}`);
    declared.add(binary.path);
    const executable = binary.kind === 'static-musl' && binary.tool === 'landlock-run' && os === 'linux';
    const addon = binary.kind === 'node-api' && binary.tool === 'flock' && binary.napi === 8;
    if (!executable && !addon) throw new Error(`${manifest.name}: unsupported binary kind/tool/NAPI for ${binary.path}`);
    if (addon && os === 'linux' && !['glibc', 'musl'].includes(binary.libc)) {
      throw new Error(`${manifest.name}: Linux addon must declare glibc or musl`);
    }
    if (addon && os === 'darwin' && binary.libc !== undefined) {
      throw new Error(`${manifest.name}: macOS addon must not declare a Linux libc`);
    }

    const file = path.join(packageDir, binary.path);
    if (!fs.existsSync(file)) throw new Error(`${manifest.name}: missing ${binary.path} — build this platform before packing`);
    if (!fs.lstatSync(file).isFile()) throw new Error(`${manifest.name}: ${binary.path} is not a regular file`);
    if (executable) {
      try { fs.accessSync(file, fs.constants.X_OK); }
      catch { throw new Error(`${manifest.name}: ${binary.path} is not executable`); }
    }
    const data = fs.readFileSync(file);
    if (os === 'linux') {
      if (data.length < 64 || data.readUInt32LE(0) !== 0x464c457f || data[4] !== 2 || data[5] !== 1) {
        throw new Error(`${manifest.name}: ${binary.path} is not a little-endian ELF64 binary`);
      }
      if (data.readUInt16LE(18) !== E_MACHINE[cpu]) {
        throw new Error(`${manifest.name}: ${binary.path} has the wrong ELF architecture`);
      }
      if (data.readUInt16LE(16) !== (executable ? 2 : 3)) {
        throw new Error(`${manifest.name}: ${binary.path} has the wrong ELF file type`);
      }
    } else {
      const expectedCpu = cpu === 'x64' ? 0x01000007 : 0x0100000c;
      if (data.length < 32 || data.readUInt32LE(0) !== 0xfeedfacf) {
        throw new Error(`${manifest.name}: ${binary.path} is not a Mach-O 64-bit bundle`);
      }
      if (data.readUInt32LE(4) !== expectedCpu || data.readUInt32LE(12) !== 8) {
        throw new Error(`${manifest.name}: ${binary.path} has the wrong Mach-O architecture or file type`);
      }
    }
    if (addon && (!data.includes(Buffer.from('napi_register_module_v1'))
      || !data.includes(Buffer.from('node_api_module_get_api_version_v1')))) {
      throw new Error(`${manifest.name}: ${binary.path} does not export the Node-API entry points`);
    }
  }

  function files(dir, prefix) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const name = prefix + '/' + entry.name;
      return entry.isDirectory() ? files(path.join(dir, entry.name), name) : [name];
    });
  }
  const extra = files(path.join(packageDir, 'bin'), 'bin').filter((name) => !declared.has(name));
  if (extra.length) throw new Error(`${manifest.name}: undeclared bin/ files: ${extra.join(', ')}`);
  return { name: manifest.name, count: declared.size };
}
