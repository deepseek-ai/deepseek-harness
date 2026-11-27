/** The shipped Web composition keeps Office conversion; native preview ships only through the Desktop bundle. */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, test } from 'vitest'

const rows = loadOverlayPatches('office-composition', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  .flatMap(patch => patch.insert ?? [])

test('every profile retains PDF conversion and no shipped row starts native Office preview', () => {
  expect(rows.filter(row => row.name === '@deepseek-ai/dsh-office-kit').map(row => row.id)).toEqual(['office-kit'])
  expect(rows.filter(row => /frame-forwarding|office-preview/u.test(row.name)).map(row => row.name)).toEqual([])
})
