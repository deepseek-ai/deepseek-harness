import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/host/share-host.ts'

describe('liveshare owner host routes', () => {
  it('registers body-mode metadata required by the connection Fetch contract', async () => {
    const paths: string[] = []
    const register = vi.fn((route: { readonly path: string; readonly requestBody?: string }) => {
      if (route.requestBody === undefined) throw new Error(`missing request body mode: ${route.path}`)
      paths.push(route.path)
      return Promise.resolve(async () => {})
    })
    const host = Object.assign(new Context(), {
      connection: {
        authenticatedUrl: () => 'http://127.0.0.1:3092/?token=test',
        fetch: { register },
      },
      webServer: { port: 3092 },
    })

    const config: Config = {}
    await apply(host, config)

    expect(paths).toEqual([
      // Share management is the `liveshareShares` Remote; these four are the sign-in and credential
      // routes the browser still posts to, and nothing else stays same-origin.
      '/api/liveshare.ownerCredential',
      '/api/liveshare.ownerLoginStart',
      '/api/liveshare.ownerLoginRedeem',
      '/api/liveshare.ownerLoginCancel',
    ])
    expect(register).toHaveBeenCalledTimes(4)
  })

  it('registers no route for the retired per-viewer approval flow', async () => {
    const paths: string[] = []
    const host = Object.assign(new Context(), {
      connection: {
        authenticatedUrl: () => 'http://127.0.0.1:3092/?token=test',
        fetch: { register: (route: { readonly path: string }) => { paths.push(route.path); return Promise.resolve(async () => {}) } },
      },
      webServer: { port: 3092 },
    })

    await apply(host, {} satisfies Config)

    for (const gone of ['/api/liveshare.requests', '/api/liveshare.grantView', '/api/liveshare.revokeView']) {
      expect(paths, gone).not.toContain(gone)
    }
  })
})
