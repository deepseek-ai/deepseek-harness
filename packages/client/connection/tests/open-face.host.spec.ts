/** Deployment-owned browser surface: an open face skips the launch-token handshake. */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

/** The proxy's own authority, as a browser behind it spells it. */
const AUTHORITY = '172.25.20.84:8080'

function indexRequest(): ConnectionIndexRequest {
  return { method: 'GET', url: '/', headers: { host: AUTHORITY } }
}

function response(): { value: ConnectionIndexResponse; state: { status?: number } } {
  const state: { status?: number } = {}
  return {
    value: {
      writeHead(status) { state.status = status },
      end() {},
    },
    state,
  }
}

/**
 * Mount one Connection over a real browser-session owner.
 * @param open - the deployment's face-ownership switch.
 * @returns the mounted service and the fiber that owns it.
 */
async function mounted(open: boolean): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  provideBrowserCredentials(ctx)
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('the credential double was not provided')
  const auth = await BrowserAuth.create({}, credentials, 30)
  const fiber = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, ['172.25.20.84'], auth, open)
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

describe('an open browser surface', () => {
  it('admits the forwarding proxy as the owner peer without a cookie', async () => {
    const { connection, dispose } = await mounted(true)
    try {
      const admission = connection.admit({ headers: { host: AUTHORITY } })
      if (!('peer' in admission)) throw new Error('an open face refused its own proxy')
      expect(admission.peer).toBe(connection.browserPeer)
    } finally {
      await dispose()
    }
  })

  it('serves the index document without a token or a cookie', async () => {
    const { connection, dispose } = await mounted(true)
    try {
      const answer = response()
      expect(connection.authorizeIndex(indexRequest(), answer.value)).toBe(true)
      expect(answer.state.status).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('announces the clean URL instead of a launch-token URL', async () => {
    const { connection, dispose } = await mounted(true)
    try {
      expect(connection.authenticatedUrl(`http://${AUTHORITY}/`)).toBe(`http://${AUTHORITY}/`)
    } finally {
      await dispose()
    }
  })

  it('leaves the launch-token handshake in place when the face is closed', async () => {
    const { connection, dispose } = await mounted(false)
    try {
      expect(connection.admit({ headers: { host: AUTHORITY } })).toEqual({ rejection: 401 })
      const answer = response()
      expect(connection.authorizeIndex(indexRequest(), answer.value)).toBe(false)
      expect(answer.state.status).toBe(401)
      expect(connection.authenticatedUrl(`http://${AUTHORITY}/`)).toContain('?token=')
    } finally {
      await dispose()
    }
  })
})
