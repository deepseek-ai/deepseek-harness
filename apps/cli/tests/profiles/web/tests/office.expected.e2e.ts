/** Ordinary Web mounts Office skills over the user's Python and leaves the bundled Python environment to Desktop. */
import { expect, it } from 'vitest'
import { withDefaultWeb } from './default-web-process.ts'

it('mounts Office skills without bundled authoring dependencies in ordinary Web', async (test) => {
  await withDefaultWeb(test, async ({ request }) => {
    const roster = await request('roster')
    expect(roster.plugins.some(plugin => plugin.name === 'skill-office')).toBe(true)
    for (const name of ['office-commands', 'tool-workspace-dependencies']) {
      expect(roster.plugins.some(plugin => plugin.name === name)).toBe(false)
    }
  })
})
