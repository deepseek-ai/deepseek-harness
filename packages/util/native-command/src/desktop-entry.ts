/** Shared XDG desktop-entry fields and icon lookup for directory and file application catalogs. */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** Decoded application icon bytes suitable for an image response or data URL. */
export interface DesktopIcon {
  readonly bytes: Buffer
  readonly contentType: 'image/png' | 'image/svg+xml'
}

/**
 * Read the main desktop-entry section without interpreting executable commands.
 * @param text - installed desktop-entry text.
 * @returns its literal field values; action sections are excluded.
 */
export function desktopEntryFields(text: string): Readonly<Record<string, string>> {
  let main = false
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) { main = trimmed === '[Desktop Entry]'; continue }
    if (!main || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator > 0) fields.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim())
  }
  return Object.fromEntries(fields)
}

/**
 * Resolve XDG application and icon roots in desktop precedence order.
 * @param home - user's home directory.
 * @param env - desktop environment values.
 * @returns data-home followed by system data directories.
 */
export function desktopDataDirectories(home: string, env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return [env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
    ...(env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':').filter(Boolean)]
}

/** Read an installed PNG or SVG icon; absent paths and directories have no pixels. */
async function readIcon(path: string): Promise<DesktopIcon | null> {
  const contentType = path.endsWith('.png') ? 'image/png' : path.endsWith('.svg') ? 'image/svg+xml' : null
  if (contentType === null) return null
  try {
    if (!(await stat(path)).isFile()) return null
    return { bytes: await readFile(path), contentType }
  } catch (_error) {
    // Missing or unreadable artwork does not remove an otherwise usable application.
    return null
  }
}

/**
 * Resolve an absolute icon path or an installed hicolor/pixmaps icon name.
 * @param name - desktop-entry Icon field.
 * @param directories - XDG data roots in precedence order.
 * @returns image bytes and media type, or null when artwork is unavailable.
 */
export async function desktopApplicationIcon(name: string, directories: readonly string[]): Promise<DesktopIcon | null> {
  if (isAbsolute(name)) return readIcon(name)
  for (const directory of directories) {
    for (const size of ['512x512', '256x256', '128x128', '64x64', '48x48', '32x32']) {
      for (const extension of ['png', 'svg']) {
        const icon = await readIcon(join(directory, 'icons', 'hicolor', size, 'apps', `${name}.${extension}`))
        if (icon !== null) return icon
      }
    }
    const scalable = await readIcon(join(directory, 'icons', 'hicolor', 'scalable', 'apps', `${name}.svg`))
    if (scalable !== null) return scalable
    for (const extension of ['png', 'svg']) {
      const icon = await readIcon(join(directory, 'pixmaps', `${name}.${extension}`))
      if (icon !== null) return icon
    }
  }
  return null
}
