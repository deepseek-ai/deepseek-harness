import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { probeZonedLoopback } from './test-non-loopback-address.ts'

const binding = vi.hoisted(() => ({ refusal: undefined as Error | undefined }))

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: vi.fn(),
}))

// The regression concerns OS interface metadata, not the test host's IPv6 availability.
vi.mock('node:http', () => ({
  createServer: () => {
    let reject: (error: Error) => void
    return {
      once(_event: string, listener: (error: Error) => void) { reject = listener },
      listen(_options: { host: string; port: number }, ready: () => void) {
        if (binding.refusal) reject(binding.refusal)
        else ready()
      },
      close(closed: () => void) { closed() },
    }
  },
}))

beforeEach(() => {
  binding.refusal = undefined
  vi.mocked(networkInterfaces).mockReturnValue({
    'Loopback Pseudo-Interface 1': [{
      address: '::1',
      netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      family: 'IPv6',
      mac: '00:00:00:00:00:00',
      internal: true,
      scopeid: 0,
      cidr: '::1/128',
    }],
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('returns a valid scoped literal when the interface display name contains spaces', async () => {
  const host = await probeZonedLoopback()
  expect(isIP(host ?? '')).toBe(6)
  expect(host).toContain('%')
})

it('skips a scoped loopback whose listener refuses the bind', async () => {
  binding.refusal = new Error('address unavailable')
  vi.spyOn(console, 'info').mockImplementation(() => {})
  expect(await probeZonedLoopback()).toBeUndefined()
})
