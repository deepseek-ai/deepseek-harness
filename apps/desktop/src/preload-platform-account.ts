/** Platform initialization copies credentials once; token getters never perform IPC. */
import { contextBridge, ipcRenderer } from 'electron'
import { PLATFORM_IPC, type PlatformLocale } from './platform-ipc.ts'

const originArgument = '--dsh-platform-origin='
const allowedOrigin = process.argv.find(argument => argument.startsWith(originArgument))?.slice(originArgument.length)
if (process.isMainFrame && location.origin === allowedOrigin) {
  let token: string | undefined
  let locale: PlatformLocale | undefined
  const localeListeners = new Set<(locale: PlatformLocale) => void>()
  ipcRenderer.on(PLATFORM_IPC.localeChanged, (_event, value: unknown) => {
    if (value !== 'en_US' && value !== 'zh_CN') return
    locale = value
    for (const listener of localeListeners) {
      try { listener(value) } catch (error) { console.error('Platform locale listener failed', error) }
    }
  })
  try {
    const value: unknown = ipcRenderer.sendSync(PLATFORM_IPC.bootstrap)
    if (typeof value === 'object' && value !== null && 'token' in value && 'origin' in value
      && typeof value.token === 'string' && value.token.length > 0 && value.origin === location.origin
      && 'locale' in value && (value.locale === 'en_US' || value.locale === 'zh_CN')) {
      token = value.token
      locale = value.locale
    }
  } catch {
    // Initialization failure retains embedded mode so Platform cannot use browser credentials.
  }
  contextBridge.exposeInMainWorld('dsh', {
    protocolVersion: 1,
    displayMode: 'embedded',
    getLocale: (): PlatformLocale => {
      if (locale === undefined) throw new Error('Platform locale initialization failed')
      return locale
    },
    onLocaleChange: (listener: (locale: PlatformLocale) => void): (() => void) => {
      localeListeners.add(listener)
      return () => { localeListeners.delete(listener) }
    },
    getAuthToken: (): string => {
      if (token === undefined) throw new Error('Platform initialization failed')
      return token
    },
  })
}
