/** Download diagnostics distinguish actionable causes without publishing raw network errors. */
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { expect, it } from 'vitest'
import { classifyDownloadFailure } from '../src/download-error.ts'

it.each([
  ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['ETIMEDOUT', 'timeout'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
  ['CERT_HAS_EXPIRED', 'certificate'], ['SELF_SIGNED_CERT_IN_CHAIN', 'certificate'],
  ['ENOSPC', 'storage'], ['EACCES', 'storage'], ['ECONNREFUSED', 'network'], ['UND_ERR_SOCKET', 'network'],
])('classifies nested %s as %s', (code, reason) => {
  const cause = Object.assign(new Error('private details'), { code })
  expect(classifyDownloadFailure(new TypeError('fetch failed', { cause: new AggregateError([new Error('unknown'), cause]) })))
    .toEqual({ reason, code })
})

it('recognizes deadlines and preserves generic classifications when a cause is unavailable', () => {
  expect(classifyDownloadFailure(new TimeoutReason('SPEECH_PREPARE_TIMEOUT', 1000))).toEqual({ reason: 'timeout' })
  expect(classifyDownloadFailure(new DOMException('expired', 'TimeoutError'))).toEqual({ reason: 'timeout' })
  expect(classifyDownloadFailure(new TypeError('fetch failed'))).toEqual({ reason: 'network' })
  expect(classifyDownloadFailure(Object.assign(new Error('unknown'), { code: 'PRIVATE_DATA' }))).toEqual({ reason: 'unknown' })
  expect(classifyDownloadFailure('unknown rejection')).toEqual({ reason: 'unknown' })
  const cyclic = new Error('unknown')
  cyclic.cause = cyclic
  expect(classifyDownloadFailure(cyclic)).toEqual({ reason: 'unknown' })
})
