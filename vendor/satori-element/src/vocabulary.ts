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
  /**
   * Values of the `<form>` the button stands in, keyed by control `name` — present when the click submitted a form
   * (`button[type=submit]`, or a plain action button inside a `<form>` on a platform that submits with any button).
   * A checkbox reports a boolean, a multiple `<select>` an array in option order.
   */
  values?: FormValues
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
  /**
   * Claim the answer for a listener that calls {@link respond} only after asynchronous work: the platform then does
   * not answer `{}` as soon as intake settles, and answers on its own only once its deadline passes. Absent where
   * {@link respond} is absent.
   */
  defer?(): void
}

/** Platform-neutral answer to a button click ({@link ButtonEvent.respond}). */
export interface ButtonAnswer {
  /** A short notice shown to the clicker. */
  toast?: { type: 'info' | 'success' | 'warning' | 'error'; content: string }
}

export type ButtonCallback = (event: ButtonEvent) => void | Promise<void>

/** Values one `<form>` submitted, keyed by the `name` of each control. */
export type FormValues = Record<string, string | string[] | boolean>

/**
 * Payload of a `<select>` interaction: the reader picked an option.
 *
 * The same forward-declaration rule as {@link ButtonEvent} applies — `plugin-im-core` augments this interface with
 * `bot`, `user`, `chat` and `message`.
 */
export interface SelectEvent {
  /** Control id (`select.id`). */
  id: string
  /** Chosen option values: one for a single select, in option order for a `multiple` one. */
  values: string[]
  /** Optional payload (≤ 256 bytes), as on a button. */
  data?: string
  /** Passive-reply / reply context the adapter may use. */
  referrer: unknown
  time: number
  /** Answer the interaction on the platform; same contract as {@link ButtonEvent.respond}. */
  respond?(answer: ButtonAnswer): Promise<void>
  /** Claim the platform's answer for asynchronous work; same contract as {@link ButtonEvent.defer}. */
  defer?(): void
}

export type SelectCallback = (event: SelectEvent) => void | Promise<void>

/**
 * Payload of a checkbox toggle: the reader checked or cleared a `input[type=checkbox]`.
 *
 * The same forward-declaration rule as {@link ButtonEvent} applies — `plugin-im-core` augments this interface with
 * `bot`, `user`, `chat` and `message`.
 */
export interface CheckEvent {
  /** Control id (`input.id`). */
  id: string
  /** State after the toggle. */
  checked: boolean
  /** Optional payload (≤ 256 bytes), as on a button. */
  data?: string
  /** Passive-reply / reply context the adapter may use. */
  referrer: unknown
  time: number
  /** Answer the interaction on the platform; same contract as {@link ButtonEvent.respond}. */
  respond?(answer: ButtonAnswer): Promise<void>
  /** Claim the platform's answer for asynchronous work; same contract as {@link ButtonEvent.defer}. */
  defer?(): void
}

export type CheckCallback = (event: CheckEvent) => void | Promise<void>

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
    | ({ type: 'submit'; id: string; data?: string; onClick?: ButtonCallback } & ButtonStyle)
  /** `width: 'fill'` shares the row among the buttons (each defaults to `width: 'fill'`); `align` places the row. */
  'button-group': { width?: 'auto' | 'fill'; align?: Align }
  /**
   * A group of form controls whose values one submit button sends together. A platform without a form container
   * renders the controls one by one and reports them as dropped interactions.
   */
  form: { name: string }
  /**
   * One form control. `checkbox` is the separate native component a platform may have, and the only one that reports
   * itself (`onChange`); every other type delivers its value only with the enclosing `<form>`'s submit, keyed by
   * `name`. At least one of `name` and `id` is required: `name` feeds a form, `id` names the toggle callback.
   */
  input: {
    /** Form key inside a `<form>`; absent on a live checkbox that only reports its own toggles. */
    name?: string
    /** Callback identity of a live checkbox. */
    id?: string
    onChange?: CheckCallback
    type?: 'text' | 'multiline' | 'password' | 'checkbox'
    /** Visible text of a checkbox; the caption above a text field. */
    label?: string
    placeholder?: string
    /** Initial value: the text of a text field, the state of a checkbox. */
    value?: string | boolean
    maxLength?: number
    required?: boolean
    disabled?: boolean
  }
  /**
   * A choice control.
   *
   * `id` and `name` name the channel, and at least one is required: an `id` makes it a live control that reports its
   * pick (`onSelect`), a `name` makes it a form field whose value arrives with the enclosing `<form>`'s submit. A
   * `multiple` control is normally a form field — what a pick reports is one option, while the complete selection is
   * what the submit carries.
   */
  select: {
    /** Callback identity of a live control; absent on a control that only feeds a form. */
    id?: string
    data?: string
    onSelect?: SelectCallback
    multiple?: boolean
    /** Form key of this control inside a `<form>`; defaults to `id`. */
    name?: string
    placeholder?: string
    /** Initially chosen option value(s). */
    value?: string | string[]
    required?: boolean
    disabled?: boolean
  }
  /** One choice of a `<select>`; the label is the element's content. */
  option: { value: string; selected?: boolean }
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
  button: 'action' | 'link' | 'input' | 'submit' | 'theme' | 'inline'
  input: 'checkbox'
  select: 'multiple'
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
