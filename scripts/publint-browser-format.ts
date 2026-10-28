import type { Message } from 'publint'

/**
 * Browser Client and Worker artifacts run outside Node's ESM loader, so their
 * CommonJS-format verdict is false; a Node Client entry must never be exempt.
 * Other publint diagnostics remain fatal.
 * @param message - one publint diagnostic for a published file.
 * @returns true only for the known browser script format verdict.
 */
export function isBrowserBundleFormatFalsePositive(message: Message): boolean {
  if (message.code !== 'FILE_INVALID_FORMAT') return false
  const filePath = (message.args as { actualFilePath?: string }).actualFilePath ?? ''
  const exportKey = Array.isArray(message.path) ? message.path.join('/') : ''
  return /(^|\/)lib\/(?:client(?:\.browser)?|worker)\.js$/.test(filePath)
    || filePath === '' && /(^|\/)\.\/worker$/.test(exportKey)
}
