/**
 * The host bundle activates the way a profile loads it: through Cordis's injection check, with the
 * dependencies it declares provided by the application.
 *
 * A fake Context handed straight to `apply` cannot catch an access to a service the plugin never
 * declared, which is how a released composition ended up with no owner surface at all.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/host/share-host.ts'
import * as ShareHost from '../src/host/share-host.ts'

/** A connection stub whose route registrations the test can read. */
function connection(paths: string[]) {
  return {
    authenticatedUrl: () => 'http://127.0.0.1:3092/?token=test',
    fetch: {
      register: (route: { readonly path: string; readonly requestBody?: string }) => {
        if (route.requestBody === undefined) throw new Error(`missing request body mode: ${route.path}`)
        paths.push(route.path)
        return Promise.resolve(async () => {})
      },
    },
  }
}

/** A host loads without any Relay address: the owner saves one in the Share dialog. */
const config: Config = {}

describe('liveshare host activation', () => {
  it('registers its owner routes when the declared dependencies are present', async () => {
    const paths: string[] = []
    const ctx = new Context()
    // The application provides what the bundle declares.
    ctx.provide('connection', connection(paths))
    ctx.provide('webServer', { port: 3092 })

    await ctx.plugin(ShareHost, config)

    expect(ShareHost.inject).toEqual(['connection'])
    // Share management is the Remote service; only the sign-in and credential routes stay same-origin.
    expect(ctx.get('liveshareShares')).toBeDefined()
    expect(paths).toEqual([
      '/api/liveshare.ownerCredential',
      '/api/liveshare.ownerLoginStart',
      '/api/liveshare.ownerLoginRedeem',
      '/api/liveshare.ownerLoginCancel',
    ])
    await ctx.fiber.dispose()
  })

  it('still activates where no agent registry exists, without limiting anyone by default', async () => {
    const paths: string[] = []
    const ctx = new Context()
    ctx.provide('connection', connection(paths))
    ctx.provide('webServer', { port: 3092 })

    await ctx.plugin(ShareHost, config)

    // The owner surface is served; the listener installs nothing for a deployment with no shares or forks,
    // and the prompt gate refuses a resumed child it cannot limit rather than driving it unconstrained.
    expect(ctx.get('liveshareShares')).toBeDefined()
    await ctx.fiber.dispose()
  })
})
