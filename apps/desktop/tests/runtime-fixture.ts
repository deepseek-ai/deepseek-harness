/** Temporary materialized packages for Desktop resource and profile behavior tests. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_HOST_RUNTIME_FILES } from '../src/core-package-set.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { writeDesktopRuntime, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

/**
 * Write a package fixture with explicit runtime exports.
 * @param modules - Owning node_modules directory.
 * @param name - Package name.
 * @param fields - Manifest fields.
 * @param source - ESM entry contents.
 * @returns Installed package directory.
 */
export function writePackage(modules: string, name: string, fields: Record<string, unknown> = {}, source = 'export const identity = {}\n'): string {
  const path = join(modules, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js', ...fields }))
  writeFileSync(join(path, 'index.js'), source)
  return path
}

/**
 * Seal a minimal release containing Host entry files and a shared Cordis package.
 * @param root - New runtime directory.
 * @param version - Shell and dsh version.
 * @param nodeVersion - Bundled Node version used for native rebuild selection.
 * @returns Sealed runtime metadata.
 */
export function runtimeFixture(root: string, version = '1.0.0', nodeVersion = '24.17.0'): DesktopRuntimeDescriptor {
  const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/cordis']
  for (const name of names) writePackage(join(root, 'node_modules'), name, { version })
  for (const file of DESKTOP_HOST_RUNTIME_FILES) {
    const path = join(root, 'node_modules', '@deepseek-ai/dsh-desktop-host', file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '')
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  return writeDesktopRuntime(root, { schemaVersion: 1, version, nodeVersion, pnpmVersion: '11.7.0', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION }, names)
}
