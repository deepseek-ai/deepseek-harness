/** Preset registry ownership across the shipped profile layers. */
import { createRequire } from 'node:module'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
function bundle(name: string) {
  return loadOverlayPatches('preset composition', require.resolve(`@deepseek-ai/dsh-${name}/cordis.patch.yml`))
}

it('enables the shared registry in headless and preserves defaults set by an earlier layer', () => {
  const id = 'agent-preset-registry'
  const base = bundle('base')
  const headless = bundle('headless')
  const web = bundle('web-app')
  const registry = (layers: Parameters<typeof composeEntries>[0]) => composeEntries(layers).filter(row => row.id === id)

  expect(registry([base])).toMatchObject([{ disabled: true }])
  expect(registry([base, headless])).toEqual([{ id, name: '@deepseek-ai/dsh-agent-preset-registry', disabled: false }])
  expect(registry([base, web, headless])).toMatchObject([{ disabled: false, config: { default: 'standard' } }])
  const config = { default: 'custom', selectedDefault: 'preferred' }
  expect(registry([base, [{ id, config }], headless])).toMatchObject([{ disabled: false, config }])
})
