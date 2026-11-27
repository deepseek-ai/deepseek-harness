/** Shipped profile templates, and the offline catalogs that do not depend on installed provider packages or registry requests. */

import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_BUNDLES, EXPERIMENTAL_BUNDLES, HIDDEN_BUNDLES, MORE_BUNDLES, OFFICIAL_CONNECTOR_CATALOG,
  OFFICIAL_ON_DEMAND_CATALOG, ON_DEMAND_BUNDLES, OPTIONAL_BUNDLES, PROFILE_TEMPLATES,
} from '../src/index.ts'

describe('Official catalogs', () => {
  it('offers exactly the two native subagent integrations on demand', () => {
    expect(ON_DEMAND_BUNDLES).toEqual(['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex'])
  })

  it.each([
    ['on-demand', ON_DEMAND_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG],
    ['connector', CONNECTOR_BUNDLES, OFFICIAL_CONNECTOR_CATALOG],
  ] as const)('embeds offline localized metadata for each %s bundle in list order', (_list, names, catalog) => {
    expect(catalog.map(entry => entry.packageName)).toEqual(names)
    for (const entry of catalog) {
      expect(entry.meta.icon).toMatch(/^data:image\/svg\+xml;base64,/)
      for (const text of [entry.meta.title, entry.meta.description]) {
        expect(text.en).toMatch(/\S/)
        expect(text.zh).toMatch(/\S/)
      }
      expect(entry).not.toHaveProperty('version')
    }
  })
})

describe('Optional Office bundle', () => {
  it('ships disabled by default and appears in More with the Experimental badge', () => {
    const office = '@deepseek-ai/dsh-office-frame-forwarding-bundle'
    expect(OPTIONAL_BUNDLES).toContain(office)
    expect(MORE_BUNDLES).toContain(office)
    expect(EXPERIMENTAL_BUNDLES.has(office)).toBe(true)
    expect(HIDDEN_BUNDLES.has(office)).toBe(false)
    for (const template of Object.values(PROFILE_TEMPLATES)) {
      expect(template.bundles).not.toContain(office)
    }
  })
})

describe('Shipped profile templates', () => {
  it('stack each mode bundle on base except the standalone minimal SDK', () => {
    expect(PROFILE_TEMPLATES).toEqual({
      acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] },
      web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
      headless: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] },
      sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] },
      'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'] },
    })
  })
})
