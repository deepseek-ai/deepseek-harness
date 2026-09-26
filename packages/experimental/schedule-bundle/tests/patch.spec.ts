/** The experimental Schedule switch must flip exactly the three rows the Web bundle inserts. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))

interface Manifest {
  name?: string
  icon?: string
  private?: boolean
  publishConfig?: { access?: string }
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

interface Patch {
  id?: string
  name?: string
  disabled?: boolean
  insert?: unknown[]
}

describe('experimental Schedule bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

  it('publishes as an experimental bundle with plugin-manager display metadata', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-experimental-schedule-bundle')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    // The patch only overrides rows another layer inserts, so it depends on no plugin package.
    expect(manifest.dependencies).toBeUndefined()
  })

  it('flips the three shipped rows on and appends none', () => {
    const parsed = yaml.load(readFileSync(resolve(root, './cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(parsed).toEqual([
      { id: 'time-context', disabled: false },
      { id: 'schedule', disabled: false },
      { id: 'ui-schedule', disabled: false },
    ])
    for (const patch of parsed as Patch[]) {
      expect(patch.insert).toBeUndefined()
      expect(patch.name).toBeUndefined()
    }
  })
})
