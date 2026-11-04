/** Ordinary Web leaves Office authoring composition to its carrier. */
import { expect, it } from 'vitest'
import { withDefaultWeb } from './default-web-process.ts'

it('does not mount Office skills, commands, or authoring dependencies in ordinary Web', async (test) => {
  await withDefaultWeb(test, async ({ request }) => {
    const roster = await request('roster')
    for (const name of ['skill-office', 'office-commands', 'tool-workspace-dependencies']) {
      expect(roster.plugins.some(plugin => plugin.name === name)).toBe(false)
    }
  })
})
