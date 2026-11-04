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
    en: 'Fetches public URLs on DeepSeek servers and returns Markdown; cannot reach intranet or loopback addresses. Incurs charges, billed to the DeepSeek account or DeepSeek API key that the Billing setting selects; see the Search & Fetch guide for pricing.',
    zh: '由 DeepSeek 服务端抓取公网页面并返回 Markdown，无法访问内网和本机。会产生费用，按「计费方式」向 DeepSeek 账号或 DeepSeek API Key 计费，计费规则详见「网页搜索与获取指南」。',
    ja: 'DeepSeek のサーバーで公開 URL を取得し、Markdown を返します。イントラネットやループバックのアドレスにはアクセスできません。料金が発生し、「課金方法」の設定に応じて DeepSeek アカウントまたは DeepSeek API キーに課金されます。料金の詳細は「検索と取得のガイド」を参照してください。',
    es: 'Obtiene URL públicas en los servidores de DeepSeek y devuelve Markdown; no puede acceder a direcciones de la intranet ni de bucle invertido. Genera cargos, facturados a la cuenta de DeepSeek o a la clave de API de DeepSeek que elija el ajuste Facturación; consulte la Guía de búsqueda y recuperación para ver los precios.',
    fr: 'Récupère les URL publiques sur les serveurs DeepSeek et renvoie du Markdown ; ne peut pas atteindre les adresses intranet ou de bouclage. Entraîne des frais, facturés au compte DeepSeek ou à la clé API DeepSeek que choisit le paramètre Facturation ; consultez le Guide de recherche et de récupération pour les tarifs.',
    de: 'Ruft öffentliche URLs auf DeepSeek-Servern ab und gibt Markdown zurück; erreicht keine Intranet- oder Loopback-Adressen. Verursacht Kosten, die dem DeepSeek-Konto oder DeepSeek-API-Schlüssel berechnet werden, den die Einstellung Abrechnung auswählt; Preise siehe Leitfaden zum Suchen und Abrufen.',
    ru: 'Загружает публичные URL на серверах DeepSeek и возвращает Markdown; адреса интрасети и loopback недоступны. Услуга платная: оплата списывается с учётной записи DeepSeek или ключа API DeepSeek, выбранных в настройке «Оплата»; тарифы см. в документе «Руководство по поиску и получению».',
    pt: 'Obtém URLs públicas nos servidores da DeepSeek e retorna Markdown; não alcança endereços da intranet nem de loopback. Gera cobranças, feitas na conta DeepSeek ou na chave de API da DeepSeek selecionada pela configuração Cobrança; consulte o Guia de pesquisa e busca para ver os preços.',
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
