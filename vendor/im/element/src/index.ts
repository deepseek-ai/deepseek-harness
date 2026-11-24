/**
 * `@deepseek-ai/satori-element`: the Satori element vocabulary.
 *
 * Also the JSX runtime entry (`jsxImportSource: '@deepseek-ai/satori-element'`): `jsx`, `jsxs`, `jsxDEV`,
 * `Fragment` and the `JSX` namespace.
 */

export * from './vocabulary.ts'
export * from './elements.ts'
export { type Attrs, type BareTag, type Component, type ElementFactory, Fragment, h, isElement, type JSX, jsx, jsxDEV, jsxs, parse } from './factory.ts'
export * from './normalize.ts'
export * from './variants.ts'
export * from './text.ts'
export { escape, unescape } from '@deepseek-ai/cordis-element'

export { h as default } from './factory.ts'
