/** Host-side response comparison for pinned model files on Hugging Face-compatible origins. */
import { deadline } from '@deepseek-ai/dsh-timeout'

/**
 * Prefer the first successful HEAD response while retaining other sources for download fallback.
 * All probes settle before returning; if every probe fails, the configured order is preserved.
 * @param assetUrl - revision-pinned upstream file URL.
 * @param origins - nonempty configured origins, or one explicit deployment origin.
 * @param timeoutMs - maximum probe duration, including redirects.
 * @param signal - preparation cancellation or deadline.
 * @returns deduplicated download URLs with the first responding source first; a single source needs no probe.
 */
export async function orderModelSources(assetUrl: string, origins: readonly string[], timeoutMs: number,
  signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted()
  const path = new URL(assetUrl).pathname
  const urls = [...new Set(origins.map(origin => new URL(path, origin).href))]
  if (urls.length === 1) return urls
  const finished = new AbortController()
  using timeout = deadline(signal, timeoutMs, 'SPEECH_SOURCE_PROBE_TIMEOUT')
  const probing = AbortSignal.any([timeout.signal, finished.signal])
  const requests = urls.map(async url => ({ url, response: await fetch(url, { method: 'HEAD', signal: probing }) }))
  let preferred: string | undefined
  try {
    preferred = await Promise.any(requests.map(async (request) => {
      const { url, response } = await request
      if (!response.ok) throw new Error(`Model source probe returned HTTP ${response.status}`)
      return url
    }))
  } catch (_unavailableSources) {
    // Downloads can still work when an origin refuses HEAD or exceeds the probe deadline.
  } finally {
    finished.abort()
    const settled = await Promise.allSettled(requests)
    await Promise.allSettled(settled.map(async (result) => {
      if (result.status === 'fulfilled') await result.value.response.body?.cancel()
    }))
  }
  signal.throwIfAborted()
  return preferred === undefined ? urls : [preferred, ...urls.filter(url => url !== preferred)]
}
