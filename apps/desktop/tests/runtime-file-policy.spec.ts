import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { desktopRuntimeFileExclusion } from '../scripts/runtime-file-policy.ts'
import { verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const windows = { platform: 'win32' as const, arch: 'x64' }

it('omits development artifacts while preserving executable modules, assets and license files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-file-policy-'))
  const source = join(root, 'source')
  const output = join(root, 'output')
  const removed = [
    'example/index.d.ts', 'example/index.d.mts', 'example/index.d.cts',
    'example/index.js.map', 'example/index.mjs.map', 'example/index.cjs.map',
    'example/style.css.map', 'example/index.d.ts.map', 'example/index.d.mts.map',
    'example/index.d.cts.map', 'example/tsconfig.tsbuildinfo',
    'fs-ext/build/Release/obj/fs_ext/native.obj', 'fs-ext/build/Release/fs_ext.pdb',
    'fs-ext/build/Release/fs_ext.lib', 'fs-ext/build/Release/fs_ext.exp',
    'fs-ext/build/Release/fs_ext.iobj', 'fs-ext/build/Release/fs_ext.ipdb',
    'fs-ext/build/binding.sln', 'fs-ext/build/config.gypi',
    'fs-ext/build/fs_ext.vcxproj', 'fs-ext/build/fs_ext.vcxproj.filters',
    'node-pty/prebuilds/win32-arm64/conpty.node',
    'node-pty/prebuilds/linux-x64/pty.node', 'node-pty/prebuilds/darwin-x64/pty.node',
    'node-pty/prebuilds/win32-x64/conpty.pdb',
    '@koromix/koffi-win32-x64/win32_x64/koffi.lib',
    '@mixmark-io/domino/test/entities.html',
    '.modules.yaml', '.pnpm-workspace-state-v1.json', '.bin/tool', '.pnpm/cache',
  ]
  const retained = [
    'example/index.js', 'example/index.cjs', 'example/index.mjs', 'example/worker.js',
    'example/source.ts', 'example/src/entry.ts', 'example/test/runtime-fixture.json',
    'example/locale.json', 'example/data.map', 'example/module.wasm',
    'example/package.json', 'example/LICENSE', 'example/NOTICE', 'example/README.md',
    'example/native.lib', 'example/native.obj', 'example/symbols.pdb',
    'fs-ext/build/Release/fs_ext.node', 'fs-ext/build/Release/runtime.dll',
    'node-pty/prebuilds/win32-x64/conpty.node',
    'node-pty/prebuilds/win32-x64/conpty_console_list.node',
    'node-pty/prebuilds/win32-x64/conpty/conpty.dll',
    'node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
    'node-pty/third_party/conpty/win10-x64/OpenConsole.exe',
    '@koromix/koffi-win32-x64/win32_x64/koffi.node',
    '@mixmark-io/domino/lib/HTMLParser.js', '@mixmark-io/domino/lib/EntityParser.js',
    '@img/sharp-win32-x64/lib/libvips-42.dll',
  ]
  try {
    const runtime = runtimeFixture(source)
    const modules = join(source, 'node_modules')
    for (const path of [...removed, ...retained]) {
      mkdirSync(join(modules, path, '..'), { recursive: true })
      writeFileSync(join(modules, path), `payload:${path}`)
    }
    cpSync(modules, join(output, 'node_modules'), {
      recursive: true, dereference: true,
      filter: path => desktopRuntimeFileExclusion(relative(modules, path), windows) === undefined,
    })
    for (const path of removed) expect(existsSync(join(output, 'node_modules', path)), path).toBe(false)
    for (const path of retained) expect(readFileSync(join(output, 'node_modules', path), 'utf8'), path).toBe(`payload:${path}`)
    const sealed = writeDesktopRuntime(output, runtime.release, runtime.sharedPackages.map(entry => entry.name))
    expect(await verifyDesktopRuntime(output, runtime.release.version)).toEqual(sealed)
    expect(readFileSync(join(modules, removed[0]!), 'utf8')).toBe(`payload:${removed[0]}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('applies package-specific rules inside scoped and nested dependency containers', () => {
  expect(desktopRuntimeFileExclusion('outer/node_modules/@mixmark-io/domino/test/data.html', windows)).toBeDefined()
  expect(desktopRuntimeFileExclusion('outer\\node_modules\\node-pty\\prebuilds\\win32-arm64\\conpty.node', windows)).toBeDefined()
  expect(desktopRuntimeFileExclusion('outer/node_modules/unrelated/test/data.html', windows)).toBeUndefined()
  expect(desktopRuntimeFileExclusion('outer/fs-ext/build/Release/fs_ext.lib', windows)).toBeUndefined()
})

it('retains native prebuilds for the selected macOS architecture', () => {
  const mac = { platform: 'darwin' as const, arch: 'arm64' }
  expect(desktopRuntimeFileExclusion('node-pty/prebuilds/darwin-arm64/pty.node', mac)).toBeUndefined()
  expect(desktopRuntimeFileExclusion('node-pty/prebuilds/darwin-x64/pty.node', mac)).toBeDefined()
  expect(desktopRuntimeFileExclusion('node-pty/prebuilds/win32-x64/conpty.node', mac)).toBeDefined()
})
