/**
 * The client's ONE syntax highlighter: a synchronous fine-grained shiki core
 * (JavaScript regex engine — no oniguruma WASM, bundle-friendly) with an
 * explicit grammar allowlist and a CSS-variables theme. Colors live in the
 * theme package's token sheets as `--shiki-*` custom properties (light and
 * dark blocks), never here — the repo's tokens-only styling rule.
 *
 * Only the three markdown-fence and `run_code` grammars (TypeScript, shell,
 * JSON) load into the singleton at boot — the set every session renders. The
 * read card's wider extension set (the file-extension language hints the read
 * tool's `langFromPath` emits — `packages/fs/tool-fs`: python, rust, yaml,
 * markup, …) is imported lazily and registered the first time such a language
 * is requested, so a session that never opens a read card in one of those
 * languages pays neither the ~1.6 MB of grammar modules nor their synchronous
 * init. The first render of a lazy language falls back to plain text while its
 * grammar loads, then {@link onGrammarLoaded} notifies subscribers to re-render
 * with highlighting. An unknown or absent language falls back to plain text (no
 * highlighting, still monospace) — never an error.
 */

import { createHighlighterCoreSync, createCssVariablesTheme } from 'shiki/core'
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript'
import langTs from '@shikijs/langs/typescript'
import langBash from '@shikijs/langs/shellscript'
import langJson from '@shikijs/langs/json'
import type { GrammarState, HighlighterCore, ThemedToken } from 'shiki/core'
import type { CSSProperties } from 'react'

/** A shiki grammar module's default export (a `LanguageRegistration[]`), taken
 *  from a boot grammar so no direct `@shikijs/types` dependency is needed. */
type LangModule = { default: typeof langTs }

/**
 * Grammars the singleton loads at boot; each entry's own `name` is the id
 * `codeToTokens`/`codeToHtml` resolve. The JS-family aliases (js/jsx/ts/tsx)
 * resolve to the TypeScript grammar rather than a separate one: it tokenizes
 * plain TS/JS exactly, and JSX/TSX approximately (shiki's TS grammar is not the
 * dedicated TSX grammar, so JSX elements tokenize imperfectly) — an accepted
 * trade to keep the boot set to one JS-family grammar. The read card's wider
 * set loads lazily through {@link LAZY_GRAMMARS}.
 */
const LANGS = [langTs, langBash, langJson]

/**
 * The read card's extension grammars, each behind a dynamic import so its
 * module stays out of the boot chunk until a read of that language renders.
 * Keyed by the grammar id (`LanguageRegistration.name`) the aliases resolve to.
 * `@shikijs/langs`' default export is a `LanguageRegistration[]`; the loader
 * hands the whole array to `loadLanguageSync`, which registers each entry
 * (including embedded sub-grammars). The three boot grammars are absent —
 * already loaded, so no alias value ever points at a missing entry here.
 */
const LAZY_GRAMMARS = new Map<string, () => Promise<LangModule>>([
  ['python', () => import('@shikijs/langs/python')],
  ['ruby', () => import('@shikijs/langs/ruby')],
  ['go', () => import('@shikijs/langs/go')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['java', () => import('@shikijs/langs/java')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['csharp', () => import('@shikijs/langs/csharp')],
  ['kotlin', () => import('@shikijs/langs/kotlin')],
  ['swift', () => import('@shikijs/langs/swift')],
  ['php', () => import('@shikijs/langs/php')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['toml', () => import('@shikijs/langs/toml')],
  ['ini', () => import('@shikijs/langs/ini')],
  ['markdown', () => import('@shikijs/langs/markdown')],
  ['mdx', () => import('@shikijs/langs/mdx')],
  ['html', () => import('@shikijs/langs/html')],
  ['css', () => import('@shikijs/langs/css')],
  ['scss', () => import('@shikijs/langs/scss')],
  ['less', () => import('@shikijs/langs/less')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['xml', () => import('@shikijs/langs/xml')],
  ['lua', () => import('@shikijs/langs/lua')],
])

/**
 * Language ids (and aliases) the highlighter accepts; everything else renders
 * plain. A Map, not an object: fence info strings are assistant-authored, so
 * a label like `constructor` or `__proto__` must miss instead of resolving an
 * inherited property and crashing the renderer inside shiki. Keys cover both
 * the markdown-fence aliases `CodeBlock` uses and the file-extension hint ids
 * the read tool's `langFromPath` emits, so both callers resolve the same
 * grammars. The JS family maps to the TypeScript grammar (see {@link LANGS} for
 * the JSX/TSX approximation). A value not in {@link LANGS} names a
 * {@link LAZY_GRAMMARS} entry loaded on first use.
 */
const LANG_ALIASES = new Map<string, string>([
  ['typescript', 'typescript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['javascript', 'typescript'],
  ['js', 'typescript'],
  ['jsx', 'typescript'],
  ['shellscript', 'shellscript'],
  ['bash', 'shellscript'],
  ['sh', 'shellscript'],
  ['shell', 'shellscript'],
  ['zsh', 'shellscript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['py', 'python'],
  ['python', 'python'],
  ['rb', 'ruby'],
  ['ruby', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rust', 'rust'],
  ['java', 'java'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['cs', 'csharp'],
  ['csharp', 'csharp'],
  ['kotlin', 'kotlin'],
  ['swift', 'swift'],
  ['php', 'php'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'mdx'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['sql', 'sql'],
  ['xml', 'xml'],
  ['lua', 'lua'],
])

/**
 * Whether a language hint can use the shared syntax highlighter.
 * @param lang - Language hint from a code surface.
 * @returns Whether the hint resolves to a supported grammar.
 */
export function supportsHighlighting(lang: string | undefined): boolean {
  return lang !== undefined && LANG_ALIASES.has(lang.toLowerCase())
}

/** All token colors resolve through `--shiki-*` custom properties (theme package sheets). */
const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
})

/**
 * The client regex engine compiles each TextMate pattern when its scanner is
 * created. Shiki otherwise defers patterns longer than 3,000 characters until
 * their first match; that compilation counts against Shiki's 500 ms per-line
 * budget and can return a partial token stream under host contention. Eager
 * compilation leaves the same budget in place for scanning user content.
 */
const regexEngine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: pattern => defaultJavaScriptRegexConstructor(pattern, {
    lazyCompileLength: Number.POSITIVE_INFINITY,
  }),
})

let singleton: HighlighterCore | undefined

/** Representative paths through every boot grammar, compiled before user content is timed. */
const BOOT_GRAMMAR_WARMUPS = [
  { lang: 'typescript', code: 'const answer: number = 42' },
  { lang: 'shellscript', code: 'printf \'%s\\n\' "$HOME"' },
  { lang: 'json', code: '{"ready":true}' },
] as const

/** Construct and pre-tokenize the boot grammars outside the user-content scan budget. */
function createHighlighter(): HighlighterCore {
  const instance = createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    langs: LANGS,
    engine: regexEngine,
  })
  for (const sample of BOOT_GRAMMAR_WARMUPS) {
    instance.codeToTokens(sample.code, {
      lang: sample.lang,
      theme: 'css-variables',
      tokenizeTimeLimit: 0,
    })
  }
  return instance
}

/** The synchronous highlighter (one instance per document); pre-warmed below, lazy as the fallback. */
function highlighter(): HighlighterCore {
  singleton ??= createHighlighter()
  return singleton
}

/** Grammar ids whose lazy import is in flight or done, so it is requested once. */
const requested = new Set<string>()
/** Subscribers re-rendered after a lazy grammar registers (React callers). */
const listeners = new Set<() => void>()
/** Bumped on each lazy-grammar load; the `useSyncExternalStore` snapshot. */
let loadCount = 0

/**
 * Subscribe to lazy-grammar load completions; `listener` fires after a
 * {@link LAZY_GRAMMARS} grammar finishes registering on the singleton, so a
 * caller that rendered its plain fallback while the grammar loaded can
 * re-highlight. Uses the `useSyncExternalStore` subscribe signature; pair it with
 * {@link grammarLoadCount} as the snapshot. Returns an unsubscribe function.
 * @param listener - invoked (no args) on each grammar-load completion.
 * @returns a disposer that removes the listener.
 */
export function subscribeGrammarLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The lazy-grammar load counter — a value that changes on every load, so a
 * `useSyncExternalStore` snapshot re-renders the subscriber when a grammar
 * registers. Opaque: only its identity across renders matters.
 * @returns the current load count.
 */
export function grammarLoadCount(): number {
  return loadCount
}

/**
 * Ensure the grammar `resolved` names is registered. A boot grammar (not in
 * {@link LAZY_GRAMMARS}) and an already-loaded lazy grammar report ready
 * synchronously; a lazy grammar not yet loaded starts its import (once) and
 * reports not-ready, so the caller renders plain until a
 * {@link subscribeGrammarLoaded} listener fires.
 * @param resolved - the grammar id an alias resolved to.
 * @returns whether the grammar is registered and ready to tokenize now.
 */
function ensureGrammar(resolved: string): boolean {
  const load = LAZY_GRAMMARS.get(resolved)
  // A boot grammar (already registered) has no lazy loader; it is always ready.
  if (load === undefined) return true
  if (highlighter().getLoadedLanguages().includes(resolved)) return true
  if (!requested.has(resolved)) {
    requested.add(resolved)
    void load().then((mod) => {
      highlighter().loadLanguageSync(mod.default)
      loadCount += 1
      for (const listener of listeners) listener()
    })
  }
  return false
}

// Engine + grammar construction costs a long task (~120-175ms); building it
// during the first finalized fence's render would jank exactly when a stream
// completes. Warm the singleton in a deferred task at module load (= plugin
// boot) instead; the lazy path above stays as the correctness fallback for a
// fence that renders before the timer fires. `unref` (Node-only) keeps a
// non-browser import from pinning the event loop.
const warmupTimer = setTimeout(() => { highlighter() }, 0)
;(warmupTimer as { unref?: () => void }).unref?.()

/**
 * Highlight `code` into shiki's HTML (a single `<pre class="shiki">` tree)
 * when `lang` maps to a registered grammar; `undefined` means the caller
 * renders its plain fallback. A lazy grammar not yet loaded returns `undefined`
 * for this call and loads in the background; subscribe with
 * {@link onGrammarLoaded} to re-highlight once it registers.
 * @param code - the source text.
 * @param lang - the language hint (a markdown fence info string or a fixed caller id).
 * @returns the highlighted HTML, or `undefined` for unknown or not-yet-loaded languages.
 */
export function highlightToHtml(code: string, lang: string | undefined): string | undefined {
  const resolved = lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase())
  if (resolved === undefined) return undefined
  if (!ensureGrammar(resolved)) return undefined
  return highlighter().codeToHtml(code, { lang: resolved, theme: 'css-variables' })
}

/**
 * One highlighted run of a line: the text and the inline style shiki assigned
 * it. The css-variables theme colors every run through a `--shiki-*` custom
 * property, so `style.color` is always present; it is held as a style object
 * rather than a bare color so a run spreads onto a `<span style>` uniformly.
 */
export interface HighlightSpan {
  text: string
  style: CSSProperties
}

/** vscode-textmate FontStyle bits shiki folds into `text-decoration` values. */
const DECORATION_BITS: readonly (readonly [number, string])[] = [[4, 'underline'], [8, 'line-through']]

/**
 * The inline style shiki's HTML arm assigns one token (`getTokenStyleObject`
 * mirrored onto React style keys): the css-variables color plus the
 * vscode-textmate font-style bits the theme lets through — italic (1), bold
 * (2), and the {@link DECORATION_BITS} decorations (the theme injects bold,
 * italic, and underline rules for markup scopes, so markdown fences carry
 * them). The theme has no per-scope backgrounds, so `background-color` never
 * occurs; the arm-parity tests fail loud if a shiki upgrade changes that.
 */
function spanStyle(token: ThemedToken): CSSProperties {
  const style: CSSProperties = { color: token.color }
  /* v8 ignore next -- fontStyle is optional in ThemedToken's type; tokenizeWithTheme always stamps it. */
  const bits = token.fontStyle ?? 0
  if ((bits & 1) !== 0) style.fontStyle = 'italic'
  if ((bits & 2) !== 0) style.fontWeight = 'bold'
  const decorations = DECORATION_BITS.filter(([bit]) => (bits & bit) !== 0)
  if (decorations.length > 0) style.textDecoration = decorations.map(([, value]) => value).join(' ')
  return style
}

/**
 * Narrow one tokenized line to the runs a `<span style>` renders, folding a
 * whitespace-only run into the token that follows it — shiki's default
 * `mergeWhitespaces` HTML behavior — with each run styled through
 * {@link spanStyle}, so the streaming spans and the settled `codeToHtml`
 * swap render one identical span tree. shiki exempts underlined/struck
 * whitespace from the fold; under the css-variables theme that case cannot
 * occur — its only underline rule styles inline-link scopes, whose spaced
 * text tokenizes as one run, and it injects no strikethrough rule — so the
 * unconditional fold here stays equivalent (the markdown arm-parity test
 * pins it). A line-trailing whitespace-only run has no follower and keeps
 * its own span, as in shiki.
 */
function lineSpans(line: ThemedToken[]): HighlightSpan[] {
  const spans: HighlightSpan[] = []
  let pendingWhitespace = ''
  for (const [index, token] of line.entries()) {
    if (/^\s+$/.test(token.content) && index + 1 < line.length) {
      pendingWhitespace += token.content
      continue
    }
    spans.push({ text: pendingWhitespace + token.content, style: spanStyle(token) })
    pendingWhitespace = ''
  }
  return spans
}

/**
 * Incremental highlighter for one growing streaming fence. TextMate
 * tokenization is line-based and forward-only — a line's tokens depend only on
 * its own text and the grammar state entering it — so appended text never
 * changes a completed line's tokens. The session caches the spans of every
 * completed line together with the grammar state after them;
 * {@link updateFrame} reports only newly completed lines plus the still-growing
 * last line, while {@link update} materializes the complete compatibility
 * result. Per-call tokenization cost therefore excludes the completed prefix,
 * and the result equals a from-scratch tokenization of the same code.
 * Non-append input and a change of resolved grammar reset the cache and
 * re-tokenize fully, so any input stays correct.
 */
export class StreamingHighlightSession {
  /** Grammar id the cache was built with; a different resolution resets it. */
  private resolved: string | undefined
  /** Newline-terminated source prefix covered by {@link spans}. */
  private prefix = ''
  /** Cached spans, one entry per completed line of {@link prefix}. */
  private spans: HighlightSpan[][] = []
  /** Grammar state after {@link prefix}; undefined = the grammar's initial state. */
  private state: GrammarState | undefined
  private lastCode: string | undefined
  private lastLang: string | undefined
  private lastResult: HighlightSpan[][] | undefined
  private generation = 0
  private lastFrame: StreamingHighlightFrame | undefined

  private reset(resolved: string | undefined): void {
    this.resolved = resolved
    this.prefix = ''
    this.spans = []
    this.state = undefined
    this.generation += 1
    this.lastFrame = undefined
  }

  /** Tokenize `text` with `resolved`, resuming from the cached grammar state when one exists. */
  private tokenize(resolved: string, text: string): ThemedToken[][] {
    return highlighter().codeToTokensBase(text, {
      lang: resolved,
      theme: 'css-variables',
      ...(this.state === undefined ? {} : { grammarState: this.state }),
    })
  }

  /**
   * Tokenize one update as a delta for a retained renderer.
   * @param code - the fence text accumulated so far.
   * @param lang - the language hint.
   * @returns Newly completed lines plus the current tail, or `undefined` for the plain arm.
   */
  updateFrame(code: string, lang: string | undefined): StreamingHighlightFrame | undefined {
    if (code === this.lastCode && lang === this.lastLang && this.lastFrame !== undefined) {
      return this.lastFrame
    }
    this.lastCode = code
    this.lastLang = lang
    this.lastResult = undefined
    const resolved = lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase())
    if (resolved === undefined || !ensureGrammar(resolved)) {
      this.reset(undefined)
      return undefined
    }
    if (resolved !== this.resolved || !code.startsWith(this.prefix)) this.reset(resolved)
    const firstNewLine = this.spans.length
    const rest = code.slice(this.prefix.length)
    const lastNewline = rest.lastIndexOf('\n')
    if (lastNewline >= 0) {
      const grownEnd = rest[lastNewline - 1] === '\r' ? lastNewline - 1 : lastNewline
      const tokens = this.tokenize(resolved, rest.slice(0, grownEnd))
      for (const line of tokens) this.spans.push(lineSpans(line))
      this.state = highlighter().getLastGrammarState(tokens)
      this.prefix = code.slice(0, this.prefix.length + lastNewline + 1)
    }
    this.lastFrame = {
      generation: this.generation,
      appended: this.spans.slice(firstNewLine),
      tail: this.tokenize(resolved, rest.slice(lastNewline + 1)).map(lineSpans),
    }
    return this.lastFrame
  }

  /**
   * Tokenize the fence's current text into per-line highlighted runs;
   * `undefined` means the caller renders its plain fallback. Idempotent per
   * (`code`, `lang`) input — repeated calls return the identical result array —
   * and a retained line keeps its span-array identity across growing calls, so
   * a React caller can reuse cached line elements. A lazy grammar not yet
   * loaded returns `undefined` and loads in the background exactly as
   * {@link highlightToHtml} does; the next call after it registers highlights.
   * @param code - the fence text accumulated so far (display-trimmed, no synthetic trailing newline).
   * @param lang - the language hint (a markdown fence info string).
   * @returns one entry per line of `code` (each an array of runs), or `undefined` for unknown or not-yet-loaded languages.
   */
  update(code: string, lang: string | undefined): readonly HighlightSpan[][] | undefined {
    if (code === this.lastCode && lang === this.lastLang && this.lastResult !== undefined) {
      return this.lastResult
    }
    const frame = this.updateFrame(code, lang)
    if (frame === undefined) return undefined
    this.lastResult = [...this.spans, ...frame.tail]
    return this.lastResult
  }
}

/** One retained-renderer update from {@link StreamingHighlightSession.updateFrame}. */
export interface StreamingHighlightFrame {
  /** Changes whenever prior completed lines must be discarded. */
  readonly generation: number
  /** Completed lines added since the preceding frame in this generation. */
  readonly appended: readonly HighlightSpan[][]
  /** The still-growing final line or lines, replaced by the next frame. */
  readonly tail: readonly HighlightSpan[][]
}

/**
 * Tokenize `code` into per-line highlighted runs when `lang` maps to a
 * registered grammar; `undefined` means the caller renders its plain fallback.
 * A line-numbered view needs the token runs split per line (one gutter number
 * per line), which the single-`<pre>` {@link highlightToHtml} does not expose,
 * so this returns shiki's own 2D line/token structure narrowed to what a run
 * renders. Each run's color is a `--shiki-*` custom property, keeping token
 * colors on the theme package's sheets exactly as the HTML path does; the
 * markup font-style bits the theme lets through (bold/italic/underline in
 * markdown scopes) are dropped — the line-numbered file view renders
 * color-only runs. The trailing newline shiki appends as a final empty line
 * is dropped so the run count matches the caller's own line array.
 * @param code - the source text.
 * @param lang - the language hint (a file-extension-derived language id).
 * @returns one entry per source line (each an array of runs), or `undefined` for unknown or not-yet-loaded languages.
 */
export function highlightLines(code: string, lang: string | undefined): HighlightSpan[][] | undefined {
  const resolved = lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase())
  if (resolved === undefined) return undefined
  if (!ensureGrammar(resolved)) return undefined
  const { tokens } = highlighter().codeToTokens(code, { lang: resolved, theme: 'css-variables' })
  // shiki tokenizes `a\nb` into two lines; a trailing newline (`a\n`) adds a
  // third, empty line the caller's own line array does not carry. Drop that
  // one terminator line so the two structures stay in step. The explicit
  // `last !== undefined` (over `tokens[...]?.length`) keeps a single branch for
  // per-file coverage, matching TerminalBlock's terminator check.
  const last = tokens[tokens.length - 1]
  const lines = tokens.length > 1 && last !== undefined && last.length === 0
    ? tokens.slice(0, -1)
    : tokens
  return lines.map(line => line.map(token => ({ text: token.content, style: { color: token.color } })))
}
