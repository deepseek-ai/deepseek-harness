/** Tests for the generated Cordis core API reference. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CORDIS_CORE_API_PAGES,
  renderCordisCoreApiPage,
  renderCordisCoreApiPages,
  type CordisCoreApiPage,
} from './cordis-core-api.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Cordis core API generation', () => {
  it('renders the five detailed pages from pinned vendor declarations', () => {
    const pages = renderCordisCoreApiPages()
    expect([...pages.keys()]).toEqual(CORDIS_CORE_API_PAGES.map(page => page.out))
    expect(pages.get('docs/cordis-api/context.md')).toContain('### ctx.extend(meta?)')
    expect(pages.get('docs/cordis-api/events.md')).toContain('## DispatchMode')
    expect(pages.get('docs/cordis-api/fiber.md')).toContain('## EffectMeta')
    expect(pages.get('docs/cordis-api/registry.md')).toContain('## Plugin')
    expect(pages.get('docs/cordis-api/service.md')).toContain('### Service.resolveIntercept')

    const fiber = pages.get('docs/cordis-api/fiber.md') ?? ''
    expect(fiber).toContain('```\n\nRegister a cleanup-aware effect on this fiber.')
    expect(fiber).toContain('- `execute` — the effect body; see `Effect` for accepted shapes.')
    expect(fiber).toContain('**Returns** a disposer that tears the effect down and settles once done.')
  })

  it('rejects a public core class without source JSDoc', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-core-api-'))
    roots.push(root)
    mkdirSync(join(root, 'vendor/cordis/src'), { recursive: true })
    writeFileSync(join(root, 'vendor/cordis/src/service.ts'), 'export class Service {\n  run(): string { return "ok" }\n}\n')
    const page: CordisCoreApiPage = {
      out: 'docs/cordis-api/service.md',
      title: 'Service',
      intro: 'Service API.',
      sections: [{ kind: 'class', file: 'vendor/cordis/src/service.ts', symbol: 'Service' }],
    }
    expect(() => renderCordisCoreApiPage(page, root)).toThrow('class Service')
  })
})
