/** Fixed-source generation preserves runtime registrations while pruning unrelated API types. */
import { describe, expect, it } from 'vitest'
import { renderLarkTypes, verifyLarkSource, type LarkSources } from './gen-vendor-im-types.ts'

const sources: LarkSources = {
  'index.ts': 'export interface Used { value: Nested }\nexport interface Nested { value: string }\nexport interface Unused { value: number }\n',
  'auth.ts': "import { Internal, BaseResponse } from '../internal'\ndeclare module '../internal' { interface Internal { auth: Used } }\n",
  'im.ts': "import * as Lark from '.'\nimport { Internal, Paginated } from '../internal'\nInternal.define({ '/messages': { GET: 'im.message.list' } })\nconst pieces = 'im.message.list'.split('.')\n",
  'contact.ts': "import { Internal } from '../internal'\n",
}

describe('Feishu codegen', () => {
  it('keeps referenced declarations transitively and preserves runtime strings', () => {
    const result = renderLarkTypes(sources, [])
    expect(result['index.ts']).toContain('interface Used')
    expect(result['index.ts']).toContain('interface Nested')
    expect(result['index.ts']).not.toContain('interface Unused')
    expect(result['im.ts']).toContain("import type * as Lark from './index.ts'")
    expect(result['im.ts']).toContain("import { Internal, type Paginated } from '../internal.ts'")
    expect(result['im.ts']).toContain("'im.message.list'.split('.')")
    expect(result['auth.ts']).toContain("declare module '../internal.ts'")
    expect(renderLarkTypes(sources, [])).toEqual(result)
  })

  it('retains types used by handwritten consumers independently of generated API methods', () => {
    const result = renderLarkTypes(sources, ['const value: Unused = { value: 1 }'])
    expect(result['index.ts']).toContain('interface Unused')
  })

  it('rejects changed input bytes before they can be used as the pinned source', () => {
    const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(() => { verifyLarkSource('abc', digest, 'fixture.ts') }).not.toThrow()
    expect(() => { verifyLarkSource('abcd', digest, 'fixture.ts') }).toThrow('integrity mismatch: fixture.ts')
  })
})
