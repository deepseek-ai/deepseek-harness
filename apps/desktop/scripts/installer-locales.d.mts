/** One installer language's compiler identifier, UI strings and NSIS Modern UI test expectations. */
export interface InstallerLocale {
  /** electron-builder language and resource filename without its suffix. */
  id: string
  /** NSIS LANG_ constant suffix. */
  nsisLanguage: string
  /** Custom installer messages, with Windows printf placeholders preserved. */
  strings: Record<string, string>
  /** Substrings of the upstream Modern UI uninstaller's welcome and finished pages. */
  uninstaller: Record<string, string>
}

/**
 * Read complete per-language JSON resources and reject inconsistent keys or placeholders.
 * @param directory - Resource directory, defaulting to Desktop installer/locales.
 * @returns Validated resources, ordered by filename.
 */
export function readInstallerLocales(directory?: string): InstallerLocale[]

/**
 * Generate NSIS LangString declarations from validated resources.
 * @param locales - All configured languages or one isolated native-test language.
 * @returns UTF-8 NSIS source with literal text escaped.
 */
export function renderInstallerStrings(locales: InstallerLocale[]): string
