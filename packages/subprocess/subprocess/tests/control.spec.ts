import { afterEach, describe, expect, it, vi } from 'vitest'

const socket = vi.hoisted(() => vi.fn(function () { return {} }))
vi.mock('node:net', () => ({ Socket: socket }))

import { openInheritedControlChannel, SUBPROCESS_CONTROL_ENV } from '../src/control.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  socket.mockClear()
})

describe('inherited control channel', () => {
  it('consumes the provider marker and opens a duplex descriptor before allowing another open', () => {
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, 'pipe')
    openInheritedControlChannel()
    expect(socket).toHaveBeenCalledExactlyOnceWith({ fd: 7, readable: true, writable: true, allowHalfOpen: true })
    expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
    expect(() => openInheritedControlChannel()).toThrow('not inherited')
    expect(socket).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'invalid'])('rejects an absent or invalid launch marker: %s', (marker) => {
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, marker)
    expect(() => openInheritedControlChannel()).toThrow('not inherited')
    expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
    expect(socket).not.toHaveBeenCalled()
  })
})
