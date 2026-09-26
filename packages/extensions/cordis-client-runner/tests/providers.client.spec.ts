import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { clientInspectProviders } from '../src/client/providers.ts'

const Component = () => null

describe('Client inspect providers', () => {
  it('exposes Tool owner fields and phases through the live slot lookup', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SlotRegistry)
    try {
      await fiber
      const slots = ctx.slots as { registerFactory(options: object, component: unknown): () => void }
      slots.registerFactory({
        name: 'provider.tool-owner', scope: 'root',
        children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
      }, Component)
      const provider = clientInspectProviders(ctx).find(item => item.manifest.id === 'Slots')!
      const result = await provider.query('listSubTree', { root: 'tool.call.toolview' }, {} as never)
      const selected = result as { selected: { catalog: { ownerProps: string[] } } }
      const owner = selected.selected.catalog.ownerProps.join('\n')
      for (const field of ['callId', 'toolName', 'useDisclosure', 'cwd', 'home', 'openFile', 'loadImage', 'inspect']) {
        expect(owner).toMatch(new RegExp(`\\b${field}\\??:`))
      }
      for (const phase of ['preparing', 'start', 'result']) expect(owner).toContain(`phase: '${phase}'`)
      expect(owner).not.toContain('truncated')
    } finally {
      await fiber.dispose()
    }
  })

  it('reports strictly discriminated Slot and Factory topology nodes', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SlotRegistry)
    await fiber
    const slots = ctx.slots as {
      registerFactory(options: object, component: unknown): () => void
    }
    slots.registerFactory({
      name: 'provider.factory',
      scope: 'root',
      children: { 'provider.factory.child': { kind: 'single', scope: 'root' } },
    }, Component)
    const provider = clientInspectProviders(ctx).find(item => item.manifest.id === 'Slots')
    if (provider === undefined) throw new Error('Slots inspect provider is missing')

    const all = await provider.query('listSubTree', undefined, {} as never) as Record<string, JsonValue>
    expect(all['trees']).toEqual(expect.arrayContaining([{
      type: 'factory',
      name: 'provider.factory',
      scope: 'root',
      children: [{
        type: 'slot',
        name: 'provider.factory.child',
        kind: 'single',
        scope: 'root',
        children: [],
      }],
    }]))

    const exact = await provider.query(
      'listSubTree', { root: 'factory:provider.factory' }, {} as never,
    ) as Record<string, JsonValue>
    expect(exact['selected']).toEqual({
      type: 'factory',
      name: 'provider.factory',
      scope: 'root',
      registrant: 'root',
    })
    await fiber.dispose()
  })
})
