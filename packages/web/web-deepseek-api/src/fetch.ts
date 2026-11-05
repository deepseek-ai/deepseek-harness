/**
 * DeepSeek Fetch API provider: page Markdown through one direct request, without
 * a model request.
 * @module @deepseek-ai/dsh-web-deepseek-api/fetch
 */
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import {
  dispatchDeepSeekWeb, hasDeepSeekWebCredential, invalidResponse, isRecord,
  type DeepSeekWebAuth, type DeepSeekWebGuidance,
} from './transport.ts'

/** Stable id the Fetch API provider registers under in the fetch registry. */
export const DEEPSEEK_FETCH_API_PROVIDER_ID = 'deepseek-fetch-api'

/** Authentication and endpoint settings snapshotted for one fetch. */
export interface DeepSeekFetchApiOptions {
  /** Ordered authentication sources of the fetch; `/fetch` is appended to the base of the source sent. */
  auth: DeepSeekWebAuth
  /** Settings that endpoint failures of the fetch name. */
  guidance: DeepSeekWebGuidance
}

/**
 * Fetch page Markdown through the DeepSeek Fetch API. The API reports neither the
 * target's status nor a final URL, and it fails when the target yields no usable
 * content, so a success is the requested page retrieved with HTTP 200.
 */
export class DeepSeekFetchApiProvider implements WebFetchProvider {
  readonly id = DEEPSEEK_FETCH_API_PROVIDER_ID
  /** Picker description: what this provider suits and what it costs or cannot do. */
  readonly description: NonNullable<WebFetchProvider['description']> = {
    en: "Can't reach intranet or local addresses. Incurs charges, paid by the account or API key chosen under Billing.",
    zh: '无法访问内网和本机。会产生费用，由「计费方式」选定的账号或 API Key 支付。',
    ja: 'イントラネットやローカルのアドレスにはアクセスできません。料金が発生し、「課金方法」で選んだアカウントまたは API キーに請求されます。',
    es: 'No puede acceder a direcciones de la intranet ni locales. Genera cargos, que paga la cuenta o la clave de API elegida en Facturación.',
    fr: "N'accède pas aux adresses intranet ou locales. Entraîne des frais, payés par le compte ou la clé API choisi dans Facturation.",
    de: 'Erreicht keine Intranet- oder lokalen Adressen. Verursacht Kosten, die das unter Abrechnung gewählte Konto oder der API-Schlüssel trägt.',
    ru: 'Адреса интрасети и локальные адреса недоступны. Услуга платная: оплата идёт с аккаунта или ключа API, выбранного в разделе «Оплата».',
    pt: 'Não acessa endereços da intranet nem locais. Gera cobranças, pagas pela conta ou chave de API escolhida em Cobrança.',
  }

  /** @param resolveOptions - the options for the NEXT fetch, read once at each fetch's entry. */
  constructor(private readonly resolveOptions: () => DeepSeekFetchApiOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasDeepSeekWebCredential(options.auth)
      && options.auth.sources.every(source => source.kind === 'misconfigured' || URL.canParse(source.baseURL))
  }

  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const options = this.resolveOptions()
    return dispatchDeepSeekWeb(options.auth, {
      path: '/fetch',
      body: { url: request.url },
      decode: (payload): WebFetchResult => {
        if (!isRecord(payload) || typeof payload.content !== 'string') throw invalidResponse()
        return { url: request.url, statusCode: 200, body: { kind: 'text', content: payload.content }, truncated: false }
      },
      guidance: options.guidance,
    }, signal)
  }
}
