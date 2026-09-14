/** Self-contained recovery document for an unavailable shell renderer or preload. */

import type { DesktopLocale } from './locale.ts'

/**
 * Render escaped diagnostics without depending on application resource files.
 * @param locale - Shell-owned translations.
 * @param message - Failure details displayed as plain text.
 * @param profileRecovery - Whether the initialized application can repair its profile.
 * @returns An HTML document suitable for an isolated emergency window.
 */
export function startupFailureDocument(locale: DesktopLocale, message: string, profileRecovery = false): string {
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  return `<!doctype html><html lang="${locale.id}"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action dsh-recovery:">
<title>${escape(locale.messages.startupFailed)}</title>
<style>:root{color-scheme:light dark;font-family:system-ui}body{max-width:720px;margin:10vh auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<main><h1>${escape(locale.messages.startupFailed)}</h1><p>${escape(locale.messages.startupReinstallAdvice)}</p>
${profileRecovery ? `<p>${escape(locale.messages.startupConfigurationAdvice)}</p>` : ''}
<pre role="alert">${escape(message)}</pre>
<form action="dsh-recovery://restart"><button>${escape(locale.messages.restartApplication)}</button></form>
${profileRecovery ? `<form action="dsh-recovery://plugins"><button>${escape(locale.messages.disableThirdPartyPlugins)}</button></form>
<form action="dsh-recovery://reset"><button>${escape(locale.messages.resetConfiguration)}</button></form>` : ''}
</main></html>`
}
