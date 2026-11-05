/**
 * DeepSeek Search API provider: one direct request per search, without an
 * auxiliary model request.
 * @module @deepseek-ai/dsh-web-deepseek-api/search
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import {
  dispatchDeepSeekWeb, hasDeepSeekWebCredential, invalidResponse, isRecord, searchAborted,
  type DeepSeekWebAuth, type DeepSeekWebGuidance,
} from './transport.ts'

/** Stable id the Search API provider registers under in the search registry. */
export const DEEPSEEK_SEARCH_API_PROVIDER_ID = 'deepseek-search-api'

/** Default Search and Fetch API base, including its `/v1/tools` prefix; `/search` and `/fetch` are appended. */
export const DEEPSEEK_WEB_API_BASE_URL = 'https://api.deepseek.com/v1/tools'

/** Default Search API result count, the service's own default. */
export const DEEPSEEK_DEFAULT_COUNT = 10

/** Default Search requests started per second, the service's account-wide 5 QPS limit. */
export const DEEPSEEK_SEARCH_REQUESTS_PER_SECOND = 5

/** Longest `ori_question` the Search API accepts, in characters. */
const ORIGINAL_QUESTION_MAX_CHARS = 128

/** Authentication, endpoint, and result settings snapshotted for one search. */
export interface DeepSeekSearchApiOptions {
  /** Ordered authentication sources of the search; `/search` is appended to the base of the source sent. */
  auth: DeepSeekWebAuth
  /** Settings that endpoint failures of the search name. */
  guidance: DeepSeekWebGuidance
  /** Results requested per search, from 1 through 50; a smaller request bound wins. */
  count: number
  /** Most Search requests this provider starts in any one-second window. */
  requestsPerSecond: number
  /** Read the user question that triggered the search; undefined or blank sends none. */
  originalQuestion?: () => string | undefined
}

/**
 * Validate a Search API response and project its sources into the web service.
 * @param response - untrusted JSON from the Search endpoint.
 * @returns sources with provider order, the display `snippet`, the model-facing `summary`, and nullable
 *   publication dates preserved.
 * @throws {@link WebError} when the response does not contain valid search results.
 */
export function mapSearchResponse(response: unknown): WebSearchResult {
  if (!isRecord(response) || !Array.isArray(response.results)) throw invalidResponse()
  const sources = response.results.map((item: unknown) => {
    if (!isRecord(item) || typeof item.url !== 'string' || item.url.length === 0
      || typeof item.title !== 'string' || typeof item.snippet !== 'string'
      || (item.summary !== undefined && typeof item.summary !== 'string')
      || (item.date !== null && typeof item.date !== 'string')) throw invalidResponse()
    return {
      url: item.url,
      ...item.title.length > 0 ? { title: item.title } : {},
      ...item.snippet.length > 0 ? { snippet: item.snippet } : {},
      ...typeof item.summary === 'string' && item.summary.length > 0 ? { summary: item.summary } : {},
      ...item.date !== null && item.date.length > 0 ? { publishedAt: item.date } : {},
    }
  })
  return { sources, truncated: false }
}

/**
 * Search through the DeepSeek Search API. HTTP redirects fail as `WEB_PROVIDER_ERROR`;
 * failures after dispatch name the endpoint and tell the model how the user can configure it.
 */
export class DeepSeekSearchApiProvider implements WebSearchProvider {
  readonly id = DEEPSEEK_SEARCH_API_PROVIDER_ID
  /** Monotonic start times (ms) of requests inside the current window, oldest first. */
  private readonly starts: number[] = []
  /** Picker description: what this provider suits and what it costs or cannot do. */
  readonly description: NonNullable<WebSearchProvider['description']> = {
    en: 'Incurs charges, paid by the account or API key chosen under Billing.',
    zh: '会产生费用，由「计费方式」选定的账号或 API Key 支付。',
    ja: '料金が発生し、「課金方法」で選んだアカウントまたは API キーに請求されます。',
    es: 'Genera cargos, que paga la cuenta o la clave de API elegida en Facturación.',
    fr: 'Entraîne des frais, payés par le compte ou la clé API choisi dans Facturation.',
    de: 'Verursacht Kosten, die das unter Abrechnung gewählte Konto oder der API-Schlüssel trägt.',
    ru: 'Услуга платная: оплата идёт с аккаунта или ключа API, выбранного в разделе «Оплата».',
    pt: 'Gera cobranças, pagas pela conta ou chave de API escolhida em Cobrança.',
  }

  /**
   * @param resolveOptions - the options for the NEXT search, read once at each
   * search's entry so one search never mixes two settings sections.
   */
  constructor(private readonly resolveOptions: () => DeepSeekSearchApiOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasDeepSeekWebCredential(options.auth)
      && options.auth.sources.every(source => source.kind === 'misconfigured' || URL.canParse(source.baseURL))
      && isPositiveInteger(options.count) && isPositiveInteger(options.requestsPerSecond)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const question = boundedQuestion(options.originalQuestion?.())
    return dispatchDeepSeekWeb(options.auth, {
      path: '/search',
      body: {
        query: request.query,
        count: Math.min(options.count, request.maxResults ?? options.count),
        need_content: false,
        ...question === undefined ? {} : { ori_question: question },
      },
      decode: mapSearchResponse,
      waitToSend: waitSignal => this.waitForRequestSlot(options.requestsPerSecond, waitSignal),
      guidance: options.guidance,
    }, signal)
  }

  /**
   * Wait until fewer than `limit` requests started within the last second,
   * inclusive of its first millisecond, then record this start.
   * @throws {@link WebError} `WEB_ABORTED` when `signal` aborts while waiting.
   */
  private async waitForRequestSlot(limit: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted === true) throw searchAborted(signal)
      const now = performance.now()
      let oldest = this.starts[0]
      while (oldest !== undefined && oldest < now - 1000) {
        this.starts.shift()
        oldest = this.starts[0]
      }
      if (oldest === undefined || this.starts.length < limit) {
        this.starts.push(now)
        return
      }
      await abortableDelay(oldest + 1001 - now, signal)
    }
  }
}

/** Resolve after `ms`, or early when `signal` aborts; the caller rechecks the signal. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Bound the triggering question to what `ori_question` accepts: whitespace
 * collapses to single spaces and the first 128 characters remain.
 * @param question - the user question, when one exists.
 * @returns the bounded question, or undefined when nothing remains.
 */
function boundedQuestion(question: string | undefined): string | undefined {
  const collapsed = question?.replace(/\s+/gu, ' ').trim() ?? ''
  if (collapsed.length === 0) return undefined
  return Array.from(collapsed).slice(0, ORIGINAL_QUESTION_MAX_CHARS).join('')
}

/** True for positive integral request limits. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
