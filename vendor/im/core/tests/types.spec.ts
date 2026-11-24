/**
 * Type-level contract tests for the IM core contracts.
 *
 * Vitest does not typecheck: the `@ts-expect-error` lines and `Expect<Equal<…>>` assertions are checked by `tsc`
 * through the host aggregate (`tsconfig.host.json` includes `vendor/im/*\/tests/**\/*.ts`).
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type Adapter, type ButtonEvent, type ChatRef, defineMode, type Element, type ElementKey,
  ElementRegistry, type Fallback, type LimitKey, type Mode, type Prepared, ResourceRef,
  type RenderContext, type UserRef,
} from '@deepseek-ai/cordis-plugin-im-core'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

// ---- a Lark-post-like mode ------------------------------------------------------------------------------------

type PostInline =
  | { tag: 'text'; text: string; style?: string[] }
  | { tag: 'a'; text: string; href: string }
  | { tag: 'at'; user_id: string }
type PostBlock =
  | { tag: 'md'; text: string }
  | { tag: 'img'; image_key: ResourceRef<'image'> }
  | { tag: 'code_block'; language?: string; text: string }
type PostNode = PostInline | PostBlock
interface PostTypes {
  node: PostNode
  draft: { msg_type: 'post'; content: PostNode[][] }
  payload: { msg_type: 'post'; content: string }
}

function postRegistry() {
  return new ElementRegistry<PostTypes>()
    .register('text', el => ({ tag: 'text', text: el.attrs.content }))
    .register('p', (el, ctx) => ctx.render(el.children))
    .register('br', () => ({ tag: 'text', text: '\n' }))
    .register('a', (el, ctx) => ({ tag: 'a', text: ctx.text(el.children), href: el.attrs.href }))
    .register('img', (el, ctx) => ({ tag: 'img', image_key: ctx.resource('image', el.attrs.src) }))
    .register('at', el => ({ tag: 'at', user_id: el.attrs.id ?? 'all' }), { variants: ['user', 'all'] })
}

const postSpec = {
  id: 'post',
  limits: { 'limit.payload.bytes': 30_000 },
  assemble: (nodes: PostNode[]) => [{ msg_type: 'post' as const, content: [nodes] }],
  serialize: (msg: Prepared<PostTypes['draft']>) => ({ msg_type: 'post' as const, content: JSON.stringify(msg.draft.content) }),
} satisfies Omit<Mode<PostTypes>, 'elements'>

describe('contract types', () => {
  it('registry builder tracks registered tags and declared variant keys', () => {
    const registry = postRegistry()
    const tags = registry.tags()
    expectTypeOf(tags).toEqualTypeOf<('text' | 'p' | 'br' | 'a' | 'img' | 'at')[]>()
    // @ts-expect-error -- the union is exact: an unregistered tag is not part of it
    expectTypeOf(tags).toEqualTypeOf<('text' | 'p' | 'br' | 'a' | 'img' | 'at' | 'pre')[]>()
    expect(tags).toEqual(['text', 'p', 'br', 'a', 'img', 'at'])

    const keys = registry.keys()
    expectTypeOf(keys).toEqualTypeOf<ElementKey[]>()
    expect(keys).toContain('element.at.all')
    expect(keys).not.toContain('element.at.role')
    expect(registry.entry('pre')).toBeUndefined()
  })

  it('defineMode accepts a mode with every base tag', () => {
    const mode = defineMode<PostTypes>()({ ...postSpec, elements: postRegistry() })
    expectTypeOf(mode).toEqualTypeOf<Mode<PostTypes>>()
    expect(mode.id).toBe('post')
  })

  it('rejects wrong node shapes, missing base tags and duplicate tags', () => {
    new ElementRegistry<PostTypes>()
      // @ts-expect-error -- wrong node shape is rejected at compile time
      .register('pre', () => ({ tag: 'markdown', content: 'x' }))

    new ElementRegistry<PostTypes>()
      // @ts-expect-error -- an array of wrong nodes is rejected too
      .register('hr', () => [{ tag: 'hr' }])

    new ElementRegistry<PostTypes>()
      // @ts-expect-error -- variants must belong to the tag's VariantMap entry
      .register('pre', el => ({ tag: 'code_block', text: el.attrs.lang ?? '' }), { variants: ['color'] })

    // @ts-expect-error -- missing base tags 'p' and 'br' are rejected
    defineMode<PostTypes>()({
      ...postSpec,
      elements: new ElementRegistry<PostTypes>().register('text', el => ({ tag: 'text', text: el.attrs.content })),
    })

    expect(() => new ElementRegistry<PostTypes>()
      .register('text', el => ({ tag: 'text', text: el.attrs.content }))
      // @ts-expect-error -- registering a tag twice is rejected (and throws at runtime)
      .register('text', el => ({ tag: 'text', text: el.attrs.content }))).toThrow()
  })

  it('handlers see typed attrs', () => {
    new ElementRegistry<PostTypes>()
      .register('a', (el) => {
        expectTypeOf(el.attrs.href).toEqualTypeOf<string>()
        // @ts-expect-error -- <a> has no src
        void el.attrs.src
        return { tag: 'text', text: '' }
      })
  })
})

// ---- element and limit keys ------------------------------------------------------------------------------------

const elementKey: ElementKey = 'element.at.all'
const variantKey: ElementKey = 'element.button.inline'
// @ts-expect-error -- unknown variant rejected
const badVariant: ElementKey = 'element.at.everyone'
// @ts-expect-error -- variants of variant-less tags are rejected
const badTagVariant: ElementKey = 'element.p.lang'
// @ts-expect-error -- unknown tag rejected
const badTag: ElementKey = 'element.blink'
// @ts-expect-error -- a limit is not an element key (limits are read with `ctx.limit`)
const limitAsKey: ElementKey = 'limit.text.chars'
const limit: LimitKey = 'limit.delete.window'
void elementKey, variantKey, badVariant, badTagVariant, badTag, limitAsKey, limit

// ---- augmentation, fallbacks, adapter surface ------------------------------------------------------------------


export type _button = Expect<Equal<Pick<ButtonEvent, 'chat' | 'user'>, { chat: ChatRef; user: UserRef }>>
const preFallback: Fallback<'pre'> = (el, { variant }) => variant === 'lang' ? [{ ...el, attrs: {} } as Element<'pre'>] : el.children
void preFallback


export type _ctx = Expect<Equal<ReturnType<RenderContext<PostTypes>['render']>, PostNode[]>>
export type _modes = Expect<Equal<Adapter<unknown, { post: Mode<PostTypes> }>['modes'], { post: Mode<PostTypes> }>>
export type _modeOrder = Expect<Equal<Adapter<unknown, { post: Mode<PostTypes>; card: Mode }>['modeOrder'], readonly ('post' | 'card')[]>>
