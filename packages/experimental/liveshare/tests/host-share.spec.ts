import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/host/share-host.ts'
import { ownerHostClaimPath } from '../src/host/owner-host-claim.ts'

/** An owner state directory outside the real DSH home, which takes a host claim when a host starts. */
function isolatedState(): { config: Config; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'liveshare-host-share-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return { config: { ownerStateFile: join(dir, 'owner-shares.json') }, dir }
}

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

    await apply(host, isolatedState().config)

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

    await apply(host, isolatedState().config satisfies Config)

    for (const gone of ['/api/liveshare.requests', '/api/liveshare.grantView', '/api/liveshare.revokeView']) {
      expect(paths, gone).not.toContain(gone)
    }
  })

  it('refuses share writes after a successor replaces the claim', async () => {
    const { config, dir } = isolatedState()
    const host = Object.assign(new Context(), {
      connection: {
        authenticatedUrl: () => 'http://127.0.0.1:3092/?token=test',
        fetch: { register: () => Promise.resolve(async () => {}) },
      },
      webServer: { port: 3092 },
    })
    const dispose = await apply(host, config)
    onTestFinished(() => dispose())
    // A record naming another live host ends this host's ownership without restarting it.
    writeFileSync(ownerHostClaimPath(dir), JSON.stringify({ hostId: 'successor', pid: process.pid + 100_000 }))
    await expect(host.liveshareShares.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/owner-state-held' })
  })
})
