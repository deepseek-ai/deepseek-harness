/** Real bundle dependency closures activate their requested client plugins without extra roster rows. */
import { FiberState } from '@deepseek-ai/cordis'
import { describe, expect, vi } from 'vitest'
import { createClientTest, webApp } from '../src/assembly/index.ts'

const HMR = '@deepseek-ai/dsh-client-hmr'
const MODULES = '@deepseek-ai/dsh-client-modules'
const SESSIONS = '@deepseek-ai/dsh-api-session-controller'
const FILE_UPLOAD = '@deepseek-ai/dsh-client-file-upload'
const hmrRoster = webApp.closure([HMR])
const sessionRoster = webApp.closure([SESSIONS])
const hmrTest = createClientTest({ roster: hmrRoster }, { awaitConnected: false })
const sessionTest = createClientTest({ roster: sessionRoster })

describe('bundle dependency closures', () => {
  hmrTest('activates HMR with its declared module provider and no Connection', async ({ start }) => {
    expect(hmrRoster.rows.map(row => row.name)).toContain(MODULES)
    const client = await start()
    const entry = [...client.ctx.loader.entries()].find(row => row.options.name === HMR)
    expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)
    expect(client.ctx.get('modules')).toBeDefined()
    expect(client.ctx.get('connection')).toBeUndefined()
  }, 60_000)

  sessionTest('activates Session Controller with its declared file-upload provider', async ({ mock, start }) => {
    expect(sessionRoster.rows.map(row => row.name)).toContain(FILE_UPLOAD)
    const client = await start()
    const entry = [...client.ctx.loader.entries()].find(row => row.options.name === SESSIONS)
    expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)
    expect(client.ctx.get('fileUpload')).toBeDefined()
    await vi.waitFor(() => {
      expect(client.ctx.sessions.list.getSnapshot().phase).toBe('ready')
      expect(mock.log.calls('session/list')).toHaveLength(1)
      expect(mock.log.streams('session/control')).toHaveLength(1)
    })
  }, 60_000)
})
