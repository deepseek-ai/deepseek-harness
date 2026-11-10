import { expect, it, vi } from 'vitest'
import { AccountUnauthorizedError, requestAccount, requestPlatform } from '../src/protocol.ts'

it.each([null, undefined])('recognizes invalid authorization without requiring business data (%s)', async (data) => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 40003, data })))
  try {
    await expect(requestAccount('https://platform.deepseek.com', '/auth-api/v0/users/current',
      'fixture-token', new AbortController().signal, {})).rejects.toBeInstanceOf(AccountUnauthorizedError)
  } finally { fetcher.mockRestore() }
})

it('does not classify an unauthenticated exchange failure as a rejected stored credential', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 40003, data: null })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange', {},
      new AbortController().signal, {})).rejects.toThrow('account: protocol')
  } finally { fetcher.mockRestore() }
})
