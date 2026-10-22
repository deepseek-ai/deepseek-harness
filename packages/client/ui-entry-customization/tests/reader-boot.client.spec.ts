// @vitest-environment jsdom
/** A page whose Peer may not list plugin bundles still boots, and the More menus keep their other rows. */
import { expect } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

const withoutPluginManager = createClientTest({ roster: webApp }, { access: action => action !== 'pluginManager/listBundles' })

withoutPluginManager('boots the shipped Web client without the Plugins page navigation', async ({ start }) => {
  const c = await start()
  expect(c.ctx.get('pluginNavigation')).toBeUndefined()
  expect(c.ctx.slots.entries('sidebar.panellist.actions').map(entry => entry.options.id)).toContain('entry-customization')
}, 60_000)
