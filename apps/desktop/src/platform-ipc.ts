/** Shared names for the desktop Platform bridge. */
/** Private desktop channels; the Platform renderer receives bootstrap and locale updates. */
export const PLATFORM_IPC = {
  bootstrap: 'dsh-platform:bootstrap',
  localeChanged: 'dsh-platform:locale-changed',
  open: 'dsh-platform:open',
  bounds: 'dsh-platform:bounds',
  close: 'dsh-platform:close',
} as const

/** Resolved Platform language; Desktop resolves the system preference before sending it. */
export type PlatformLocale = 'en_US' | 'zh_CN'
