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
  /** API base the API key is sent to, including its path prefix; `/fetch` is appended. An account token goes to its own base. */
  baseURL: string
  /** Authentication sources of the fetch. */
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
    en: 'Fetches public URLs on DeepSeek servers and returns Markdown. Bills the DeepSeek account or a DeepSeek API key, as its billing setting chooses, may incur API charges, and cannot reach intranet or loopback addresses.',
    zh: '由 DeepSeek 服务端抓取公网页面并返回 Markdown。按计费方式设置使用 DeepSeek 账号或 DeepSeek API Key 计费，可能产生费用，且无法访问内网和本机',
    ja: 'DeepSeek のサーバーで公開 URL を取得し、Markdown を返します。課金方法の設定に応じて DeepSeek アカウントまたは DeepSeek API キーに課金され、API 料金が発生する場合があり、イントラネットやループバックのアドレスにはアクセスできません。',
    es: 'Obtiene URL públicas en los servidores de DeepSeek y devuelve Markdown. Factura a la cuenta de DeepSeek o a una clave de API de DeepSeek, según el ajuste de facturación, puede generar cargos de API y no puede acceder a direcciones de la intranet ni de bucle invertido.',
    fr: "Récupère les URL publiques sur les serveurs DeepSeek et renvoie du Markdown. Facture le compte DeepSeek ou une clé API DeepSeek selon le paramètre de facturation, peut entraîner des frais d'API et ne peut pas atteindre les adresses intranet ou de bouclage.",
    de: 'Ruft öffentliche URLs auf DeepSeek-Servern ab und gibt Markdown zurück. Rechnet je nach Abrechnungseinstellung über das DeepSeek-Konto oder einen DeepSeek-API-Schlüssel ab, kann API-Kosten verursachen und erreicht keine Intranet- oder Loopback-Adressen.',
    ru: 'Загружает публичные URL на серверах DeepSeek и возвращает Markdown. Оплачивается учётной записью DeepSeek или ключом API DeepSeek в зависимости от настройки оплаты, возможна оплата API; адреса интрасети и loopback недоступны.',
    pt: 'Obtém URLs públicas nos servidores da DeepSeek e retorna Markdown. Cobra da conta DeepSeek ou de uma chave de API da DeepSeek, conforme a configuração de cobrança, pode gerar cobranças de API e não alcança endereços da intranet nem de loopback.',
  }

  /** @param resolveOptions - the options for the NEXT fetch, read once at each fetch's entry. */
  constructor(private readonly resolveOptions: () => DeepSeekFetchApiOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasDeepSeekWebCredential(options.auth) && URL.canParse(options.baseURL)
  }

  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const options = this.resolveOptions()
    return dispatchDeepSeekWeb(options.auth, {
      baseURL: options.baseURL,
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
