/** Client inspection replies preserve child Session ownership through the shipped Web RPC path. */
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test page permitted to use global RPCs but no Session. */
    'inspect-test-page': { readonly kind: 'inspect-test-page' }
  }
}

it('answers Client queries for subagents without adopting their Session as an ordinary Agent', async () => {
  const scaffold = await launchWebScaffold()
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect.poll(() => scaffold.ctx.cordisInspect.list().some(provider => provider.platform === 'client')).toBe(true)
      const child = await scaffold.ctx.agents.create({
        sessionId: brandString<SessionId>('inspect-child'),
        meta: { origin: 'subagent', parentSession: brandString<SessionId>('inspect-parent') },
      })
      try {
        expect(await scaffold.ctx.sessionController.resolveAgent(child.agent.id)).toMatchObject({ error: { code: 'session/agent-busy' } })
        const result = await scaffold.ctx.cordisInspect.query('client', 'Service', 'listService', undefined, child.agent, new AbortController().signal)
        expect(result).toHaveProperty('mode', 'catalog')
        expect(result).toHaveProperty('services', expect.arrayContaining([expect.objectContaining({ key: 'layout' })]))
        const peer = new Peer(scaffold.ctx, { principal: { kind: 'inspect-test-page' } })
        const unregister = scaffold.ctx.remoteAccess.registerPolicy('inspect-test-page', { bindings: () => [{
          role: { name: 'inspect-global', resource: 'global', actions: ['dynamicCordisRunner/resolveInspectQuery'] },
          resource: { kind: 'global' },
        }] })
        try {
          await expect(scaffold.ctx.typertGateway.invoke({
            peer, namespace: 'dynamicCordisRunner', method: 'resolveInspectQuery',
            args: { agentId: child.agent.id, requestId: 'inspect-0', resolution: { ok: true, data: {} } },
          })).rejects.toMatchObject({ code: 'remote-access/denied' })
        } finally {
          unregister()
          await peer.dispose()
        }
        expect(child.agent.session.header.origin).toBe('subagent')
        expect(scaffold.ctx.agents.get(child.agent.id)).toBe(child.agent)
      } finally {
        await child.dispose()
      }
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
