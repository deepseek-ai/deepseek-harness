/**
 * Builds and loads `fixtures/fake-sink.cc`, a stand-in for Desktop's shared-texture hop sink that native tests attach
 * to the built receiver, with the host toolchain: MSVC's developer environment on Windows, clang++ on macOS.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { nativeBuildEnvironment } from '../../../../apps/desktop/scripts/native-package-builds.mjs'

/** One presentation the fake sink accepted. */
export interface FakePresented {
  /** Identifier the fake assigned: the presentation's position among accepted ones, from "1". */
  id: string
  metadata: string
  /** Eight-byte Host-local handle, valid until the presentation settles. */
  handle: Buffer
  width: number
  height: number
  timeoutMs: number
  pixelFormat: number
}

/** Exports of the fake sink addon; `native` identifies one sink to the other operations. */
export interface FakeSinkAddon {
  /** A sink whose `sink` external owns one reference, as Desktop's does; `magic` and `version` override its ABI header. */
  create(header?: { magic?: number; version?: number }): { sink: object; native: object }
  presented(native: object): FakePresented[]
  /** Run the presentation's delivery (error text or null) or settlement (`invalidated`) callback on a native thread. */
  answer(native: object, id: string, kind: 'delivered' | 'settled', value: string | null | boolean): void
  /**
   * Refuse the next presentation with `reason`: `code` 1 (`DSH_SHARED_TEXTURE_PRESENT_REJECTED`, the default) refuses
   * only that frame, 2 (`DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED`) reports that the sink lost its connection.
   */
  refuseNext(native: object, reason: string, code?: 1 | 2): void
  /** Deliver and release later presentations inside `present`. */
  answerInline(native: object, enabled: boolean): void
  references(native: object): { refs: number; retains: number; releases: number }
  /** The receiver's name for the default hardware D3D11 adapter; null outside Windows. */
  defaultAdapter(): string | null
}

const fixtures = fileURLToPath(new URL('../../../../apps/desktop/tests/frame-forwarding/fixtures/', import.meta.url))
const native = fileURLToPath(new URL('../native/', import.meta.url))
const desktopSinkHeaders = fileURLToPath(new URL('../../../../apps/desktop/native/shared-texture/', import.meta.url))

/**
 * Build the fake sink into `directory` and load it. On Windows the loaded file stays open until the process exits.
 * @param directory - Scratch directory for build outputs.
 * @returns The addon exports, and a runner of further build commands in the same toolchain environment.
 */
export function buildFakeSink(directory: string): { fakes: FakeSinkAddon; run: (command: string, args: string[]) => void } {
  const environment = nativeBuildEnvironment(process.arch)
  const headers = environment.DSH_NODE_API_HEADERS ?? ''
  const run = (command: string, args: string[]): void => {
    const result = spawnSync(command, args, { cwd: directory, env: environment, encoding: 'utf8', timeout: 120_000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stdout + result.stderr).toBe(0)
  }
  const output = join(directory, 'fake-sink.node')
  const source = join(fixtures, 'fake-sink.cc')
  if (process.platform === 'win32') {
    run('lib.exe', ['/nologo', `/def:${join(headers, 'def', 'node_api.def')}`, '/name:node.exe', `/machine:${process.arch}`, `/out:${join(directory, 'node.lib')}`])
    run('cl.exe', ['/nologo', '/LD', '/EHsc', '/MD', '/std:c++17', `/I${join(headers, 'include')}`, `/I${desktopSinkHeaders}`, '/DNAPI_VERSION=8',
      '/DNODE_GYP_MODULE_NAME=fake_sink', `/Fo${directory}\\`, source, join(desktopSinkHeaders, 'win-delay-load.cc'),
      '/link', '/DELAYLOAD:node.exe', 'delayimp.lib', join(directory, 'node.lib'), 'd3d11.lib', 'dxgi.lib',
      `/IMPLIB:${join(directory, 'fake-sink.lib')}`, `/OUT:${output}`])
  } else {
    run('clang++', ['-arch', process.arch === 'x64' ? 'x86_64' : 'arm64', '-std=c++17', `-I${join(headers, 'include')}`, `-I${desktopSinkHeaders}`,
      '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=fake_sink', '-shared', '-undefined', 'dynamic_lookup', source, '-o', output])
  }
  return { fakes: createRequire(import.meta.url)(output) as FakeSinkAddon, run }
}

/** Compile a producer fixture against the receiver transport inside the test's scratch directory.
 * @param directory - Private output directory owned by the test.
 * @param name - Fixture source basename.
 * @param run - Build command runner using the host toolchain environment.
 * @returns Executable path.
 */
export function buildFixtureProducer(directory: string, name: string, run: (command: string, args: string[]) => void): string {
  const windows = process.platform === 'win32'
  const output = join(directory, windows ? `${name}.exe` : name)
  const sources = [join(fixtures, `${name}.cc`), join(fixtures, 'fixture-client.cc'), join(native, 'transport.cc')]
  if (windows) {
    run('cl.exe', ['/nologo', '/EHsc', '/MD', '/std:c++17', '/D_WIN32_WINNT=0x0602', `/I${native}`, ...sources,
      '/link', 'd3d11.lib', 'dxgi.lib', 'advapi32.lib', 'bcrypt.lib', `/OUT:${output}`])
  } else {
    run('clang++', ['-arch', process.arch === 'x64' ? 'x86_64' : 'arm64', '-std=c++17', `-I${native}`, ...sources,
      '-framework', 'IOSurface', '-framework', 'CoreFoundation', '-lbsm', '-o', output])
  }
  return output
}
