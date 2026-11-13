/** Desktop authentication is owned by its mounted plugin fiber. */
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { expect, it, onTestFinished } from 'vitest'
import * as DesktopAuthentication from '../src/index.ts'

it('owns the provider and shared Peer while retaining only an in-memory credential reader in config', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Connection).await()
  const secret = 'A'.repeat(43)
  const config = { readSecret: () => secret }
  expect(JSON.stringify(config)).toBe('{}')
  const plugin = ctx.plugin(DesktopAuthentication, config)
  await plugin.await()
  const request = { headers: { cookie: `dsh-desktop-session=${secret}` } }
  const first = ctx.connection.authentication.authenticate(request)
  if ('rejection' in first) throw new Error('Desktop provider did not activate')
  expect(first.peer).not.toBe(ctx.connection.browserPeer)
  expect(ctx.connection.authentication.authenticate(request)).toEqual({ peer: first.peer })
  expect(ctx.connection.authentication.authenticate({ headers: new Headers(request.headers) })).toEqual({ peer: first.peer })
  expect(ctx.connection.authentication.authenticate({ headers: new Headers() })).toEqual({ rejection: 401 })
  expect(ctx.connection.authentication.authenticate({ headers: new Headers({ cookie: 'dsh-desktop-session=wrong' }) })).toEqual({ rejection: 401 })
  expect(ctx.connection.authentication.authenticate({ headers: { cookie: 'dsh-desktop-session=wrong' } })).toEqual({ rejection: 401 })
  await plugin.dispose()
  expect(first.peer.signal.aborted).toBe(true)
  expect(ctx.connection.authentication.authenticate(request)).toEqual({ rejection: 401 })
})
