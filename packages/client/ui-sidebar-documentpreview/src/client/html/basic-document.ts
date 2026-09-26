/** Static HTML preview with no scripts, network resources, forms or nested frames. */
import { decodeText } from './bytes.ts'
import DOMPurify from 'dompurify'

/**
 * Prepare static content before the browser can load any document resources.
 * @param data - complete UTF-8 HTML bytes.
 * @returns document with the restrictive CSP first in its head.
 */
export function createBasicHtmlDocument(data: Uint8Array<ArrayBuffer>): string {
  const clean = DOMPurify.sanitize(decodeText(data), {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['noscript', 'base', 'link', 'meta', 'iframe', 'frame', 'object', 'embed', 'set', 'animate', 'animateMotion', 'animateTransform'],
    FORBID_ATTR: ['href', 'xlink:href'],
  })
  const parsed = new DOMParser().parseFromString(clean, 'text/html')
  const policy = parsed.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'")
  parsed.head.prepend(policy)
  return `<!doctype html>${parsed.documentElement.outerHTML}`
}
