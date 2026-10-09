/** Anonymous provider protocols, bounded JSON intake and normalized Chinese language tags. */
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Config } from './index.ts'
import type { AnonymousTranslationProvider, AnonymousTranslationSpec } from './types.ts'
import { TranslationError } from './error.ts'
import { createHash } from 'node:crypto'

/**
 * Identify anonymous request semantics without provider-specific language normalization.
 * @param provider - explicitly resolved endpoint route.
 * @param config - deployment endpoints; raw endpoint values are excluded from stored recipes.
 * @returns protocol revision and effective endpoint fingerprint for durable result reuse.
 */
export function anonymousRecipe(provider: AnonymousTranslationProvider, config: Config): string {
  const url = new URL(provider === 'google' ? config.googleEndpoint : config.bingEndpoint)
  const owned = provider === 'google' ? ['client', 'sl', 'tl', 'dt', 'q'] : ['from', 'to', 'isEnterpriseClient']
  for (const key of owned) url.searchParams.delete(key)
  return JSON.stringify([provider === 'google' ? 'google-form-v1' : 'bing-edge-v1', createHash('sha256').update(url.href).digest('hex')])
}

function language(tag: string, provider: AnonymousTranslationProvider): string {
  const lower = tag.toLowerCase()
  if (['zh', 'zh-cn', 'zh-sg', 'zh-hans'].includes(lower)) return provider === 'google' ? 'zh-CN' : 'zh-Hans'
  if (['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].includes(lower)) return provider === 'google' ? 'zh-TW' : 'zh-Hant'
  return tag
}

function requestFor(spec: AnonymousTranslationSpec, config: Config): { url: URL; init: RequestInit } {
  const source = language(spec.sourceLanguage, spec.provider)
  const target = language(spec.targetLanguage, spec.provider)
  switch (spec.provider) {
    case 'google': {
      const url = new URL(config.googleEndpoint)
      const form = new URLSearchParams({ client: 'gtx', sl: source, tl: target, dt: 't', q: spec.text })
      for (const key of form.keys()) url.searchParams.delete(key)
      return { url, init: { method: 'POST', body: form.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' } } }
    }
    case 'bing': {
      const url = new URL(config.bingEndpoint)
      if (source !== 'auto') url.searchParams.set('from', source)
      else url.searchParams.delete('from')
      url.searchParams.set('to', target)
      url.searchParams.set('isEnterpriseClient', 'false')
      return { url, init: { method: 'POST', body: JSON.stringify([spec.text]),
        headers: { 'content-type': 'application/json' } } }
    }
    /* v8 ignore next -- TranslationProvider is a closed typed union; JSON/config validation owns admission. */
    default: return assertNever(spec.provider)
  }
}

function invalidResponse(provider: AnonymousTranslationProvider): TranslationError {
  return new TranslationError('TRANSLATION_INVALID_RESPONSE', `${provider} returned an invalid translation response`)
}

function translationOf(payload: unknown, provider: AnonymousTranslationProvider): string {
  if (!Array.isArray(payload)) throw invalidResponse(provider)
  const first: unknown = payload[0]
  switch (provider) {
    case 'google': {
      if (!Array.isArray(first) || first.length === 0) throw invalidResponse(provider)
      const segments: unknown[] = first
      return segments.map((segment) => {
        if (!Array.isArray(segment)) throw invalidResponse(provider)
        const text: unknown = segment[0]
        if (typeof text !== 'string') throw invalidResponse(provider)
        return text
      }).join('')
    }
    case 'bing': {
      if (typeof first !== 'object' || first === null || !('translations' in first) || !Array.isArray(first.translations)) {
        throw invalidResponse(provider)
      }
      const translated: unknown = first.translations[0]
      if (typeof translated !== 'object' || translated === null || !('text' in translated) || typeof translated.text !== 'string') {
        throw invalidResponse(provider)
      }
      return translated.text
    }
    /* v8 ignore next -- TranslationProvider is a closed typed union; JSON/config validation owns admission. */
    default: return assertNever(provider)
  }
}

async function responseJson(response: Response, config: Config, provider: AnonymousTranslationProvider): Promise<unknown> {
  if (response.body === null) throw invalidResponse(provider)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > config.maxResponseBytes) {
        await reader.cancel()
        throw new TranslationError('TRANSLATION_RESPONSE_LIMIT', `${provider} translation response exceeds ${config.maxResponseBytes} bytes`)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return payload
  } catch (_error) {
    throw new TranslationError('TRANSLATION_INVALID_RESPONSE', `${provider} returned invalid translation JSON`)
  }
}

/**
 * Send one bounded request without cookies, credentials, redirects or provider fallback.
 * @param spec - resolved text and provider-language choices.
 * @param config - endpoints, deadline and response-byte limit.
 * @param signal - caller and service lifetime cancellation.
 * @returns provider-translated text, or a safe failure preserving cancellation.
 */
export async function translateText(spec: AnonymousTranslationSpec, config: Config, signal: AbortSignal): Promise<string> {
  using timeout = deadline(signal, config.timeoutMs, 'TRANSLATION_TIMEOUT')
  try {
    timeout.signal.throwIfAborted()
    if (spec.text === '') return ''
    const { url, init } = requestFor(spec, config)
    const response = await fetch(url, { ...init, redirect: 'error', credentials: 'omit', signal: timeout.signal })
    if (!response.ok) {
      await response.body?.cancel()
      throw new TranslationError('TRANSLATION_HTTP_ERROR', `${spec.provider} translation failed (HTTP ${response.status})`)
    }
    const payload = await responseJson(response, config, spec.provider)
    timeout.signal.throwIfAborted()
    return translationOf(payload, spec.provider)
  } catch (error) {
    const expired = timeoutOf(timeout.signal, 'TRANSLATION_TIMEOUT')
    if (expired !== undefined && expired !== signal.reason) {
      throw new TranslationError('TRANSLATION_TIMEOUT', `${spec.provider} translation timed out after ${expired.timeoutMs}ms`)
    }
    timeout.signal.throwIfAborted()
    if (error instanceof TranslationError) throw error
    throw new TranslationError('TRANSLATION_REQUEST_FAILED', `${spec.provider} translation request failed`)
  }
}
