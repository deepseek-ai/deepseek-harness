/** The bundle inserts frame forwarding as the row every consumer bundle shares, so concurrent consumers run one instance. */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

it('inserts frame forwarding as the shared consumer row without a config, then the Office preview', () => {
  const rows = loadOverlayPatches('office-frame-forwarding-bundle', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
  expect(rows).toEqual([
    { id: 'frame-forwarding', name: '@deepseek-ai/dsh-frame-forwarding' },
    { id: 'office-preview', name: '@deepseek-ai/dsh-client-ui-office-frame-forwarding' },
  ])
})
