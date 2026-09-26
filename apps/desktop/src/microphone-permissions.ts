/** Microphone access belongs to the primary application frame and the operating system. */
import { systemPreferences, type Session, type WebContents } from 'electron'

function applicationFrame(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'dsh-app:' && parsed.hostname === 'app'
  } catch (_error) { return false /* Invalid frame URLs cannot request microphone access. */ }
}

/**
 * Handle microphone requests from the owned application window; other permissions retain Electron's defaults.
 * @param session - application's browser session.
 * @param primary - current primary window contents, absent while no window is open.
 */
export function installMicrophonePermissions(session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>, primary: () => WebContents | undefined): void {
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission !== 'media') return true
    return contents != null && contents === primary() && details.isMainFrame
      && applicationFrame(origin) && details.mediaType === 'audio'
      && (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted')
  })
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') { callback(true); return }
    const allowed = contents === primary() && details.isMainFrame && applicationFrame(details.requestingUrl)
      && 'mediaTypes' in details && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'
    if (!allowed) { callback(false); return }
    if (process.platform !== 'darwin') { callback(true); return }
    void systemPreferences.askForMediaAccess('microphone').then(callback, () => { callback(false) })
  })
}
