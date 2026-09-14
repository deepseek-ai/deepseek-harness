/** Real Web startup, mounted plugin package identities, and delivered Client graph isolation. */

import { FiberState } from '@deepseek-ai/cordis'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import { expect, it } from 'vitest'
import { experimentalRuntimeReferences, modulePackage } from './runtime-roster.ts'
import { withDefaultWeb, webGet } from './default-web-process.ts'

const experimentalName = '@deepseek-ai/dsh-experimental-client-ui-agent-team'

it('boots the default Web profile without experimental Host modules, mounted plugins, or Client entries', async (test) => {
  await withDefaultWeb(test, async ({ url, request }) => {
    const auth = await webGet(url, test.signal)
    const cookie = auth.headers['set-cookie']?.[0]?.split(';', 1)[0]
    expect(cookie).toBeDefined()
    const page = await webGet(new URL('/', url), test.signal, { cookie: cookie! })
    expect(page.status).toBe(200)
    const html = page.text
    const rawBoot = /globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/u.exec(html)?.[1]
    expect(rawBoot, html).toBeDefined()
    const delivered = JSON.parse(rawBoot!) as WebBootGraph
    const roster = await request('roster')
    expect(roster.client).toEqual(delivered)
    expect(roster.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '@deepseek-ai/dsh-host-webserver', state: FiberState.ACTIVE }),
      expect.objectContaining({ name: '@deepseek-ai/dsh-client-modules', state: FiberState.ACTIVE }),
    ]))
    expect(roster.entries.some(entry => entry.name.endsWith('/runtime-roster-observer.js') && entry.state === FiberState.ACTIVE)).toBe(true)
    expect(roster.plugins.length).toBeGreaterThan(roster.entries.length)
    expect(roster.modules.some(url => modulePackage(url) === '@deepseek-ai/dsh')).toBe(true)
    expect(roster.client.entries.length).toBeGreaterThan(0)
    expect(experimentalRuntimeReferences(roster)).toEqual([])

    const contaminated = await request('mount-experimental')
    expect(contaminated.entries.some(entry => entry.name === experimentalName)).toBe(false)
    const mounted = contaminated.plugins.filter(plugin => plugin.modules.some(url => modulePackage(url) === experimentalName))
    expect(mounted).toEqual([expect.objectContaining({ state: FiberState.ACTIVE })])
    expect(experimentalRuntimeReferences(contaminated)).toEqual(expect.arrayContaining([
      expect.stringContaining('/packages/experimental/client-ui-agent-team/'),
    ]))
  })
})
