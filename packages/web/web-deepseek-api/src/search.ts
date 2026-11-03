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
  /** API base the API key is sent to, including its path prefix; `/search` is appended. An account token goes to its own base. */
  baseURL: string
  /** Authentication sources of the search. */
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
    en: 'Queries the search endpoint directly for titles, URLs, and snippets without an extra model call. Uses the DeepSeek account of the current conversation, or a DeepSeek API key, and may incur API charges.',
    zh: '直接请求搜索接口返回标题、URL 与摘要，无需额外调用模型。使用当前会话的 DeepSeek 账号或 DeepSeek API Key，可能产生计费',
    ja: '追加のモデル呼び出しなしで検索エンドポイントに直接問い合わせ、タイトル、URL、スニペットを返します。現在の会話の DeepSeek アカウント、または DeepSeek API キーを使用し、API 料金が発生する場合があります。',
    es: 'Consulta directamente el punto de conexión de búsqueda y devuelve títulos, URL y fragmentos sin una llamada adicional al modelo. Usa la cuenta de DeepSeek de la conversación actual o una clave de API de DeepSeek, y puede generar cargos de API.',
    fr: "Interroge directement le point de terminaison de recherche pour obtenir titres, URL et extraits, sans appel de modèle supplémentaire. Utilise le compte DeepSeek de la conversation en cours ou une clé API DeepSeek, et peut entraîner des frais d'API.",
    de: 'Fragt den Suchendpunkt direkt nach Titeln, URLs und Ausschnitten ab, ohne zusätzlichen Modellaufruf. Verwendet das DeepSeek-Konto der aktuellen Unterhaltung oder einen DeepSeek-API-Schlüssel und kann API-Kosten verursachen.',
    ru: 'Напрямую запрашивает поисковый сервис и возвращает заголовки, URL и фрагменты без дополнительного вызова модели. Использует учётную запись DeepSeek текущего разговора или ключ API DeepSeek; возможна оплата API.',
    pt: 'Consulta diretamente o endpoint de pesquisa e retorna títulos, URLs e trechos sem uma chamada extra ao modelo. Usa a conta DeepSeek da conversa atual ou uma chave de API da DeepSeek e pode gerar cobranças de API.',
  }

  /**
   * @param resolveOptions - the options for the NEXT search, read once at each
   * search's entry so one search never mixes two settings sections.
   */
  constructor(private readonly resolveOptions: () => DeepSeekSearchApiOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasDeepSeekWebCredential(options.auth) && URL.canParse(options.baseURL)
      && isPositiveInteger(options.count) && isPositiveInteger(options.requestsPerSecond)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const question = boundedQuestion(options.originalQuestion?.())
    return dispatchDeepSeekWeb(options.auth, {
      baseURL: options.baseURL,
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
