import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as os from 'node:os'
import { queryEnvironment } from '../src/environment-query.ts'
import { collectEnvironment } from '../src/environment.ts'

vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof os>(),
  platform: vi.fn(), cpus: vi.fn(), totalmem: vi.fn(), release: vi.fn(), machine: vi.fn(),
}))
vi.mock('../src/environment-query.ts', () => ({ queryEnvironment: vi.fn() }))

const options = () => ({ timeoutMillis: 5000, maxOutputBytes: 16384, signal: new AbortController().signal })
const windows = { major: 10, minor: 0, build: '26300', revision: 9457 }
const processors = [{ cores: 8, architecture: 9 }, { cores: 6, architecture: 9 }]
const macVersion = 'ProductName: macOS\nProductVersion: 27.0.1\nBuildVersion: 26A434\n'
const macCpu = 'hw.physicalcpu: 8\nhw.optional.arm64: 1\n'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  vi.mocked(os.platform).mockReturnValue('win32')
  vi.mocked(os.release).mockReturnValue('10.0.26300')
  vi.mocked(os.machine).mockReturnValue('x86_64')
  vi.mocked(os.totalmem).mockReturnValue(32 * 1024 ** 3)
  vi.mocked(os.cpus).mockReturnValue(Array.from({ length: 20 }, () => ({
    model: 'Fixture CPU', speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  })))
})
afterEach(() => { vi.unstubAllEnvs() })

function outputs(version: unknown = windows, cpu: unknown = processors): void {
  vi.mocked(queryEnvironment).mockResolvedValueOnce({ kind: 'value', stdout: JSON.stringify(version) })
    .mockResolvedValueOnce({ kind: 'value', stdout: JSON.stringify(cpu) })
}

it('preserves Windows revision and sums physical cores across sockets independently of logical count', async () => {
  outputs()
  expect(await collectEnvironment(options())).toEqual({
    os_name: 'windows', os_version: 'win32 10.0.26300', os_version_full: '10.0.26300.9457', os_build: '26300',
    os_arch: 'x64', app_arch: process.arch, cpu_model: 'Fixture CPU', cpu_logical_count: 20,
    cpu_physical_core_count: 14, memory_total_bytes: 34359738368, missing_fields: {},
  })
  for (const [command, args] of vi.mocked(queryEnvironment).mock.calls) {
    expect(command).toContain('powershell.exe')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le')
    expect(script).not.toMatch(/UUID|SerialNumber|ProductId|Hostname|Win32_ComputerSystemProduct/i)
  }
})

it.each([0, 9457, 9458])('retains a genuine Windows revision of %s', async (revision) => {
  outputs({ ...windows, revision })
  expect((await collectEnvironment(options())).os_version_full).toBe(`10.0.26300.${revision}`)
})

it('does not invent revision zero when UBR is missing', async () => {
  outputs({ ...windows, revision: null })
  const result = await collectEnvironment(options())
  expect(result.os_build).toBe('26300')
  expect(result).not.toHaveProperty('os_version_full')
  expect(result.missing_fields).toEqual({ os_version_full: 'unavailable' })
})

it('marks missing build, major, and minor without discarding CPU metadata', async () => {
  outputs({ major: null, minor: null, build: null, revision: null })
  const result = await collectEnvironment(options())
  expect(result.missing_fields).toEqual({ os_version_full: 'unavailable', os_build: 'unavailable' })
  expect(result.cpu_physical_core_count).toBe(14)
})

it.each([
  { major: -1, minor: 0, build: '26300', revision: 9457 },
  { ...windows, revision: '9457' }, { ...windows, build: '26300.9457' },
])('rejects invalid Windows version JSON: %j', async (version) => {
  outputs(version)
  expect((await collectEnvironment(options())).missing_fields).toMatchObject({ os_version_full: 'invalid-value', os_build: 'invalid-value' })
})

it.each([{ cpu: [] }, { cpu: [{ cores: 0, architecture: 9 }] }, { cpu: [{ cores: '8', architecture: 9 }] }])('rejects invalid CPU fields: %j', async ({ cpu }) => {
  outputs(windows, cpu)
  expect((await collectEnvironment(options())).missing_fields).toEqual({ os_arch: 'invalid-value', cpu_physical_core_count: 'invalid-value' })
})

it.each([null, 99])('marks unavailable CPU architecture %s and physical cores', async (architecture) => {
  outputs(windows, [{ cores: null, architecture }])
  const result = await collectEnvironment(options())
  expect(result.missing_fields).toEqual({ os_arch: 'unavailable', cpu_physical_core_count: 'unavailable' })
  expect(result).not.toHaveProperty('cpu_physical_core_count')
})

it('does not merge conflicting socket architectures', async () => {
  outputs(windows, [{ cores: 4, architecture: 9 }, { cores: 4, architecture: 12 }])
  expect((await collectEnvironment(options())).missing_fields.os_arch).toBe('unavailable')
})

it('reads native Windows ARM64 independently of the application binary', async () => {
  outputs(windows, [{ cores: 8, architecture: 12 }])
  const result = await collectEnvironment(options())
  expect(result.os_arch).toBe('arm64')
  expect(result.app_arch).toBe(process.arch)
})

it.each([undefined, ''])('omits Windows query fields when SystemRoot is %s', async (root) => {
  vi.stubEnv('SystemRoot', root)
  const result = await collectEnvironment(options())
  expect(queryEnvironment).not.toHaveBeenCalled()
  expect(result.missing_fields).toEqual({ os_version_full: 'unavailable', os_build: 'unavailable', os_arch: 'unavailable', cpu_physical_core_count: 'unavailable' })
})

it.each(['timeout', 'output-limit', 'query-failed'] as const)('isolates %s from local CPU and memory fields', async (reason) => {
  vi.mocked(queryEnvironment).mockResolvedValue({ kind: 'missing', reason })
  const result = await collectEnvironment(options())
  expect(result.cpu_model).toBe('Fixture CPU')
  expect(result.memory_total_bytes).toBe(34359738368)
  expect(result.missing_fields).toEqual({ os_version_full: reason, os_build: reason, os_arch: reason, cpu_physical_core_count: reason })
})

it('rejects malformed JSON without exposing raw output', async () => {
  vi.mocked(queryEnvironment).mockResolvedValue({ kind: 'value', stdout: 'private output' })
  const result = await collectEnvironment(options())
  expect(result.missing_fields.os_version_full).toBe('invalid-value')
  expect(JSON.stringify(result)).not.toContain('private')
})

it.each(['1', undefined, '0'])('reports macOS product version and native architecture when arm64=%s', async (arm) => {
  vi.mocked(os.platform).mockReturnValue('darwin')
  vi.mocked(os.release).mockReturnValue('26.0.0')
  vi.mocked(queryEnvironment).mockResolvedValueOnce({ kind: 'value', stdout: macVersion })
    .mockResolvedValueOnce({ kind: 'value', stdout: arm === undefined ? 'hw.physicalcpu: 8\n' : macCpu.replace('arm64: 1', `arm64: ${arm}`) })
  const result = await collectEnvironment(options())
  expect(result).toMatchObject({ os_name: 'macos', os_version: 'darwin 26.0.0', os_version_full: '27.0.1', os_build: '26A434',
    os_arch: arm === '1' ? 'arm64' : 'x64', app_arch: process.arch, cpu_physical_core_count: 8, missing_fields: {} })
  expect(vi.mocked(queryEnvironment).mock.calls.map(([command, args]) => [command, args])).toEqual([
    ['/usr/bin/sw_vers', []], ['/usr/sbin/sysctl', ['-i', 'hw.physicalcpu', 'hw.optional.arm64']],
  ])
})

it('preserves macOS security response suffixes', async () => {
  vi.mocked(os.platform).mockReturnValue('darwin')
  vi.mocked(queryEnvironment).mockResolvedValueOnce({ kind: 'value', stdout: `${macVersion}ProductVersionExtra: (a)\n` })
    .mockResolvedValueOnce({ kind: 'value', stdout: macCpu })
  expect((await collectEnvironment(options())).os_version_full).toBe('27.0.1 (a)')
})

it.each(['', 'ProductVersion: garbage\nBuildVersion: private\nProductVersionExtra: invalid',
  'ProductVersion: 27.0.1\nBuildVersion: bad\nProductVersionExtra: invalid'])('rejects invalid macOS metadata: %s', async (stdout) => {
  vi.mocked(os.platform).mockReturnValue('darwin')
  vi.mocked(queryEnvironment).mockResolvedValueOnce({ kind: 'value', stdout })
    .mockResolvedValueOnce({ kind: 'value', stdout: 'hw.physicalcpu: 0\nhw.optional.arm64: unknown' })
  expect((await collectEnvironment(options())).missing_fields).toEqual({
    os_version_full: 'invalid-value', os_build: 'invalid-value', cpu_physical_core_count: 'invalid-value', os_arch: 'invalid-value',
  })
})

it('reports macOS query failure independently of Node fields', async () => {
  vi.mocked(os.platform).mockReturnValue('darwin')
  vi.mocked(queryEnvironment).mockResolvedValue({ kind: 'missing', reason: 'timeout' })
  expect((await collectEnvironment(options())).missing_fields).toEqual({ os_version_full: 'timeout', os_build: 'timeout', os_arch: 'timeout', cpu_physical_core_count: 'timeout' })
})

it.each([0, Number.NaN, 1.5])('marks unavailable memory %s instead of reporting zero', async (memory) => {
  vi.mocked(os.totalmem).mockReturnValue(memory)
  vi.mocked(os.cpus).mockReturnValue([])
  outputs()
  const result = await collectEnvironment(options())
  expect(result).not.toHaveProperty('memory_total_bytes')
  expect(result.missing_fields).toMatchObject({ memory_total_bytes: 'unavailable', cpu_model: 'unavailable', cpu_logical_count: 'unavailable' })
})

it('isolates refused synchronous OS sources', async () => {
  for (const source of [os.totalmem, os.cpus, os.release]) vi.mocked(source).mockImplementation(() => { throw new Error('source refused') })
  outputs()
  expect((await collectEnvironment(options())).missing_fields).toMatchObject({ os_version: 'unavailable', memory_total_bytes: 'unavailable', cpu_model: 'unavailable', cpu_logical_count: 'unavailable' })
})

it('marks unsupported platform queries without spawning commands', async () => {
  vi.mocked(os.platform).mockReturnValue('linux')
  expect((await collectEnvironment(options())).missing_fields).toEqual({ os_version_full: 'unsupported', os_build: 'unsupported', os_arch: 'unsupported', cpu_physical_core_count: 'unsupported' })
  expect(queryEnvironment).not.toHaveBeenCalled()
})


it.each(['', 'ProductVersionExtra: (a)\n', 'ProductVersionExtra:\n'])('accepts an inline macOS response suffix without doubling it: %s', async (extra) => {
  vi.mocked(os.platform).mockReturnValue('darwin')
  vi.mocked(queryEnvironment).mockResolvedValueOnce({ kind: 'value', stdout: macVersion.replace('27.0.1', '13.4.1 (a)') + extra })
    .mockResolvedValueOnce({ kind: 'value', stdout: macCpu })
  expect((await collectEnvironment(options())).os_version_full).toBe('13.4.1 (a)')
})

it('rejects conflicting macOS response suffixes', async () => {
  vi.mocked(os.platform).mockReturnValue('darwin')
  vi.mocked(queryEnvironment).mockResolvedValueOnce({ kind: 'value', stdout: macVersion.replace('27.0.1', '13.4.1 (a)') + 'ProductVersionExtra: (b)\n' })
    .mockResolvedValueOnce({ kind: 'value', stdout: macCpu })
  expect((await collectEnvironment(options())).missing_fields.os_version_full).toBe('invalid-value')
})
