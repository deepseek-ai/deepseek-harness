/** Sequential paragraph translation for one expanded reasoning disclosure. */
import type { TranslationRequest } from '@deepseek-ai/dsh-experimental-translator/types'

/** One source fragment and its untranslated separator. */
interface Fragment { text: string; suffix: string; complete: boolean }

/** Display-only result retained while this reasoning disclosure is mounted. */
export interface TranslationState { text: string; pending: boolean; failed: boolean }

/** Cancellation-aware callback supplied by the Remote consumer. */
export type TranslateText = (request: TranslationRequest, signal: AbortSignal) => Promise<string>

/**
 * Split reasoning into completed paragraphs and request-sized fragments.
 * @param text - original reasoning, including its exact whitespace.
 * @param running - whether the final paragraph may still grow.
 * @param maxTextChars - translator's configured UTF-16 request limit.
 * @returns whitespace-preserving fragments with completion flags for translation eligibility.
 */
export function reasoningFragments(text: string, running: boolean, maxTextChars: number): Fragment[] {
  const result: Fragment[] = []
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  let start = 0
  while (true) {
    const match = separator.exec(text)
    let remaining = text.slice(start, match?.index ?? text.length)
    while (remaining.length > maxTextChars) {
      let cut = maxTextChars
      if (/[\uD800-\uDBFF]/.test(remaining.charAt(cut - 1))) cut -= 1
      const whitespace = remaining.slice(0, cut).search(/\s+\S*$/)
      if (whitespace > 0) cut = whitespace
      const source = remaining.slice(0, cut)
      remaining = remaining.slice(cut)
      const suffix = remaining.match(/^\s+/)?.[0] ?? ''
      remaining = remaining.slice(suffix.length)
      result.push({ text: source, suffix, complete: true })
    }
    result.push({ text: remaining, suffix: match?.[0] ?? '', complete: match !== null || !running })
    if (match === null) return result
    start = match.index + match[0].length
  }
}

/** One lifecycle controller owns cancellation, request ordering, and stale-result exclusion. */
export class ReasoningTranslation {
  private readonly controller = new AbortController()
  private readonly cache = new Map<string, string>()
  private fragments: Fragment[] = []
  private pending = false
  private failed = false

  /**
   * @param selection - explicit provider and resolved target language.
   * @param maxTextChars - configured translator request limit.
   * @param translate - one cancellation-aware Remote request.
   * @param publish - component-local display state update.
   */
  constructor(
    private readonly selection: Pick<TranslationRequest, 'provider' | 'targetLanguage'>,
    private readonly maxTextChars: number,
    private readonly translate: TranslateText,
    private readonly publish: (state: TranslationState) => void,
  ) {}

  /**
   * Adopt the current source and enqueue newly completed fragments.
   * @param text - current original reasoning.
   * @param running - whether its tail is still streaming.
   */
  update(text: string, running: boolean): void {
    this.fragments = reasoningFragments(text, running, this.maxTextChars)
    this.emit()
    void this.run()
  }

  /** Retry untranslated fragments after a failed request. */
  retry(): void { this.failed = false; void this.run() }

  /** Abort the disclosure's requests and suppress all later publications. */
  dispose(): void { this.controller.abort() }

  private isDisposed(): boolean { return this.controller.signal.aborted }

  private emit(): void {
    if (this.isDisposed()) return
    const text = this.fragments.map((fragment) => {
      const content = fragment.complete ? this.cache.get(fragment.text) ?? fragment.text : fragment.text
      return content + fragment.suffix
    }).join('')
    this.publish({ text, pending: this.pending, failed: this.failed })
  }

  private async run(): Promise<void> {
    if (this.pending || this.failed || this.isDisposed()) return
    let next = this.fragments.find(fragment => fragment.complete && fragment.text.trim() !== '' && !this.cache.has(fragment.text))
    if (next === undefined) return
    this.pending = true
    this.emit()
    try {
      while (next !== undefined) {
        const translated = await this.translate({ ...this.selection, text: next.text }, this.controller.signal)
        if (this.isDisposed()) return
        this.cache.set(next.text, translated)
        this.emit()
        next = this.fragments.find(fragment => fragment.complete && fragment.text.trim() !== '' && !this.cache.has(fragment.text))
      }
    } catch (_error) {
      if (!this.isDisposed()) this.failed = true
    } finally {
      this.pending = false
      this.emit()
    }
  }
}
