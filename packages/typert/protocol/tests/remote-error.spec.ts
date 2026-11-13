import { describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

describe('RemoteError', () => {
  it('is a HarnessError that keeps its Remote code, details, and cause', () => {
    const cause = new Error('backend closed')
    const error = new RemoteError('gateway/bad-request', 'name is required', { issues: [{ path: ['name'] }] }, { cause })

    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({
      name: 'RemoteError',
      code: 'gateway/bad-request',
      message: 'name is required',
      details: { issues: [{ path: ['name'] }] },
      cause,
    })
    expect(remoteErrorOf(error)).toBe(error)
  })
})
