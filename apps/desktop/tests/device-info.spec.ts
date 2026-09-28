import { afterEach, expect, it, vi } from 'vitest'
import { readDeviceInfo } from '../src/device-info.ts'

const os = vi.hoisted(() => ({ cpus: vi.fn(), totalmem: vi.fn() }))
vi.mock('node:os', () => os)

/**
 * Replace the process face the reader sees, keeping the fields the real process owns.
 * @param platform - operating system platform reported to the reader.
 * @param arch - application architecture reported to the reader.
 * @param osVersion - system version answer, or a thrower for an unavailable source.
 */
function stubProcess(platform: string, arch: string, osVersion: () => string): void {
  vi.stubGlobal('process', { ...process, platform, arch, getSystemVersion: osVersion })
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it.each([
  ['darwin', 'arm64', '15.6', 'Apple M4', 32, 'platform=darwin; os=15.6; app_arch=arm64; cpu=Apple M4; memory_gib=32.0'],
  ['win32', 'x64', '10.0.26100', 'Intel(R) Core(TM) i7-13700H', 16, 'platform=win32; os=10.0.26100; app_arch=x64; cpu=Intel(R) Core(TM) i7-13700H; memory_gib=16.0'],
] as const)(
  'describes a %s application on %s with one decimal of memory', (platform, arch, osVersion, model, memoryGib, expected) => {
    stubProcess(platform, arch, () => osVersion)
    os.cpus.mockReturnValue([{ model }])
    os.totalmem.mockReturnValue(memoryGib * 1024 ** 3)
    expect(readDeviceInfo()).toBe(expected)
  },
)

it('reports fractional memory in GiB rounded to one decimal', () => {
  stubProcess('darwin', 'arm64', () => '15.6')
  os.cpus.mockReturnValue([{ model: 'Apple M4' }])
  os.totalmem.mockReturnValue(17_543_000_000)
  expect(readDeviceInfo().split('; ').at(-1)).toBe('memory_gib=16.3')
})

it('omits a field whose source is absent instead of failing the whole description', () => {
  stubProcess('linux', 'x64', () => '6.6.0')
  os.cpus.mockReturnValue([])
  os.totalmem.mockReturnValue(8 * 1024 ** 3)
  expect(readDeviceInfo()).toBe('platform=linux; os=6.6.0; app_arch=x64; memory_gib=8.0')
})

it('omits the fields whose sources throw and keeps the rest', () => {
  stubProcess('win32', 'x64', () => { throw new Error('refused') })
  os.cpus.mockImplementation(() => { throw new Error('refused') })
  os.totalmem.mockImplementation(() => { throw new Error('refused') })
  expect(readDeviceInfo()).toBe('platform=win32; app_arch=x64')
})
