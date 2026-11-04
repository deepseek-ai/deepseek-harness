/**
 * Satori element vocabulary: the typed overlay over the `cordis-element` runtime.
 *
 * Runtime objects stay `cordis-element` elements (`type` / `attrs` / `children`, `toString()` for logs and goldens);
 * everything here is structural typing, so no conversion is ever needed.
 */

export type Theme = 'default' | 'info' | 'success' | 'warning' | 'danger'
export type Color = 'default' | 'muted' | 'info' | 'success' | 'warning' | 'danger'
export type Align = 'left' | 'center' | 'right'

/**
 * Payload of a `button[type=action]` interaction.
 *
 * Forward declaration: the vocabulary only knows the platform-neutral fields. `plugin-im-core` augments this
 * interface (module augmentation of `@deepseek-ai/satori-element`) with `bot`, `user`, `chat` and `message`, which
 * are protocol types this package cannot depend on.
 */
export interface ButtonEvent {
  /** Button id (`button[type=action].id`). */
  id: string
  /** Optional payload (≤ 256 bytes; QQ data, Lark value). */
  data?: string
  /** Passive-reply / reply context the adapter may use (QQ event_id, Lark open_message_id). */
  referrer: unknown
  time: number
  /**
   * Answer the interaction on the platform, when the platform lets a click carry an answer (a Lark card callback
   * answers with a toast). Resolves once the answer was sent; only the first call counts, and a later call resolves
   * without effect. Absent on platforms without such an answer, and the platform answers on its own once its deadline
   * passes, so a caller that updates the clicked message after answering awaits this first.
   */
  respond?(answer: ButtonAnswer): Promise<void>
}

/** Platform-neutral answer to a button click ({@link ButtonEvent.respond}). */
export interface ButtonAnswer {
  /** A short notice shown to the clicker. */
  toast?: { type: 'info' | 'success' | 'warning' | 'error'; content: string }
}

export type ButtonCallback = (event: ButtonEvent) => void | Promise<void>

/** Size of a button (`ButtonStyle.size`). */
export type ButtonSize = 'tiny' | 'small' | 'medium' | 'large'

/**
 * Exact visual type of a button on platforms that name one (the Lark card `type`); it takes precedence over `theme`
 * there, and platforms without these types ignore it.
 */
export type ButtonVariant =
  | 'default' | 'primary' | 'danger' | 'text' | 'primary_text' | 'danger_text' | 'primary_filled' | 'danger_filled'
  | 'laser'

/**
 * Optional presentation of a button, shared by every `button` type; a platform ignores what it cannot show. A type
 * alias rather than an interface, so attribute records stay assignable to `Record<string, unknown>`.
 */
export type ButtonStyle = {
  theme?: Theme
  disabled?: boolean
  size?: ButtonSize
  /** `default` (fits the label), `fill` (the available width) or a width in pixels. */
  width?: 'default' | 'fill' | number
  /** Platform icon token (a Feishu standard icon such as `done_outlined`). */
  icon?: string
  /** Confirmation dialog shown before the click takes effect. */
  confirm?: { title: string; text: string }
  /** Hover text. */
  tip?: string
  /** Hover text while `disabled`. */
  disabledTip?: string
  variant?: ButtonVariant
}

/** Merge-extensible: adapters augment it only for namespaced pure-content tags (none in v1). */
export interface ElementMap {
  message: {}
  quote: { id: string }
  title: { subtitle?: string; theme?: Theme }
  text: { content: string }
  b: {}
  i: {}
  u: {}
  s: {}
  spoiler: {}
  code: {}
  a: { href: string }
  at: { type: 'user' | 'all' | 'here' | 'role'; id?: string; name?: string }
  channel: { id: string; name?: string }
  emoji: { id: string; name?: string }
  span: { color?: Color }
  br: {}
  p: {}
  h1: {}
  h2: {}
  h3: {}
  h4: {}
  h5: {}
  h6: {}
  ul: {}
  ol: { start?: number }
  li: { checked?: boolean }
  blockquote: {}
  pre: { lang?: string }
  hr: {}
  table: {}
  tr: {}
  th: { align?: Align }
  td: { align?: Align }
  details: { open?: boolean }
  summary: {}
  small: {}
  img: { src: string; alt?: string; width?: number; height?: number }
  audio: { src: string; name?: string; duration?: number }
  video: { src: string; name?: string; duration?: number; poster?: string }
  file: { src: string; name?: string; size?: number }
  button:
    | ({ type: 'action'; id: string; data?: string; onClick?: ButtonCallback } & ButtonStyle)
    | ({ type: 'link'; href: string } & ButtonStyle)
    | ({ type: 'input'; text: string; send?: boolean } & ButtonStyle)
  /** `width: 'fill'` shares the row among the buttons (each defaults to `width: 'fill'`); `align` places the row. */
  'button-group': { width?: 'auto' | 'fill'; align?: Align }
  /**
   * Ordered alternatives: each direct child (a fragment counts as one) is a candidate, and a renderer uses the first
   * candidate it renders without degrading anything, else the last candidate.
   */
  fallback: {}
  /** @internal One candidate of a `<fallback>`; created by the factories and `normalize`, never written by hand. */
  case: {}
  /** Input only; removed by `normalize`. */
  markdown: { content: string }
  /** Inbound only. */
  forward: { id: string }
  /** Inbound only. */
  raw: { platform: string; type: string; data?: unknown }
}

export type Tag = keyof ElementMap

/** Variant vocabulary: produces `element.<tag>.<variant>` keys. */
export interface VariantMap {
  at: 'user' | 'all' | 'here' | 'role'
  li: 'checked' | 'nested'
  pre: 'lang'
  span: 'color'
  table: 'align'
  td: 'block'
  img: 'inline'
  button: 'action' | 'link' | 'input' | 'theme' | 'inline'
}

/** Variants declared for a tag (`never` for tags without variants). */
export type VariantOf<K extends Tag> = K extends keyof VariantMap ? VariantMap[K] : never

/** `element.<tag>` and `element.<tag>.<variant>` capability keys (re-exported by plugin-im-core). */
export type ElementKey = {
  [K in Tag]: `element.${K}` | (K extends keyof VariantMap ? `element.${K}.${VariantMap[K]}` : never)
}[Tag]

/** One element of a specific tag. */
export interface TypedElement<K extends Tag> {
  type: K
  attrs: ElementMap[K]
  children: Element[]
  /** Optional stable identity used by streaming diffs (React-like key, no React semantics). */
  key?: string
  /** XML-ish form for logs and goldens (`cordis-element` runtime). */
  toString(strip?: boolean): string
}

/**
 * An element. `Element` (no argument) is the discriminated union over every tag, so `el.type === 'a'` narrows
 * `el.attrs` to `{ href: string }`; `Element<'a'>` is that single member.
 */
export type Element<K extends Tag = Tag> = K extends Tag ? TypedElement<K> : never

export type Fragment = string | Element | readonly (string | Element)[]

/**
 * Anything the factories, JSX and `normalize` accept as children: a `Fragment` plus numbers, nested arrays and the
 * conditional-rendering holes `null`, `undefined`, `true`, `false` (which render nothing).
 */
export type Child = string | number | boolean | null | undefined | Element | readonly Child[]
