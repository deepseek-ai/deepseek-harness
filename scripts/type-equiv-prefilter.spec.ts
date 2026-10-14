import { describe, expect, it } from 'vitest'
import { markdownFences } from './markdown.ts'
import { mayContainEquivFence } from './type-equiv-prefilter.ts'

const EQUIV_INFOS = new Set(['ts type-equiv', 'ts public-api', 'ts type-equiv public-api'])

function parsesEquivFence(source: string): boolean {
  return markdownFences(source).some(fence => EQUIV_INFOS.has(fence.info))
}

describe('type-equivalence prefilter', () => {
  it.each([
    '```ts type-equiv\ninterface A {}\n```\n',
    '~~~ts public-api\nclass A {}\n~~~\n',
    '> ```ts type-equiv\n> interface A {}\n> ```\n',
    '```ts type&#45;equiv\ninterface A {}\n```\n',
    '```ts type\\-equiv\ninterface A {}\n```\n',
    '```&#116;s type-equiv\ninterface A {}\n```\n',
    '~~~ts public&#x2D;api\nclass A {}\n~~~\n',
  ])('keeps a document whose fence parses as a source-equivalence form: %j', (source) => {
    expect(parsesEquivFence(source)).toBe(true)
    expect(mayContainEquivFence(source)).toBe(true)
  })

  it.each([
    '# Title\n\nPlain prose with a `type` word and an & sign.\n',
    '```ts\ninterface A {}\n```\n',
    '```sh\npnpm run build\n```\n',
  ])('skips a document without such a fence: %j', (source) => {
    expect(parsesEquivFence(source)).toBe(false)
    expect(mayContainEquivFence(source)).toBe(false)
  })
})
