/** Preserve electron-notarize's signature checks and stapling while recording separate Apple phases. */
import { fileURLToPath } from 'node:url'
import { notarize } from '@electron/notarize'
import { packagingStep } from './packaging-step.mjs'

/**
 * Notarize and staple one App or DMG through the measured notarytool adapter.
 * @param {object} options Validated credentials and appPath accepted by electron-notarize.
 * @returns {Promise<void>} Resolves only after Apple acceptance and stapling.
 */
export async function notarizeMacOS(options) {
  const secrets = Object.entries(options).filter(([name]) => /password|key|appleId/iu.test(name)).map(([, value]) => String(value))
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'notarize-and-staple',
    () => notarize({ ...options, notarytoolPath: fileURLToPath(new URL('./logged-notarytool.mjs', import.meta.url)) }), secrets)
}
