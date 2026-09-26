/** Linux file associations from GIO, with shared XDG metadata and artwork lookup. */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { desktopApplicationIcon, desktopDataDirectories, desktopEntryFields } from './desktop-entry.ts'
import type { NativeCommandRunner } from './runner.ts'
import type { NativeFileApplication } from './types.ts'

/** Find a desktop id, including ids derived from nested application directories. */
async function desktopFile(root: string, id: string, directory = root): Promise<string | null> {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (_error) {
    // An absent XDG root contributes no applications.
    return null
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (!entry.isDirectory() && relative(root, path).split(sep).join('-') === id) return path
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await desktopFile(root, id, join(directory, entry.name))
      if (found !== null) return found
    }
  }
  return null
}

/**
 * Query all registered file handlers from GIO without executing desktop-entry command text.
 * @param path - verified local file path.
 * @param signal - caller cancellation.
 * @param run - native command runner.
 * @param env - XDG and locale settings.
 * @returns registered applications with the desktop's default marked.
 */
export async function linuxFileApplications(
  path: string, signal: AbortSignal, run: NativeCommandRunner, env: NodeJS.ProcessEnv,
): Promise<readonly NativeFileApplication[]> {
  const info = await run('gio', ['info', '-a', 'standard::content-type', path], signal)
  const mime = /standard::content-type:\s*(\S+)/.exec(info.stdout)?.[1]
  if (mime === undefined) throw new Error('GIO did not identify the file content type')
  const result = await run('env', ['LC_ALL=C', 'gio', 'mime', mime], signal)
  const preferred = /^Default application.*:\s*(.+\.desktop)\s*$/m.exec(result.stdout)?.[1]
  const ids = [...new Set([...(preferred === undefined ? [] : [preferred]), ...result.stdout.split(/\r?\n/)
    .filter(line => /^\s+.*\.desktop\s*$/.test(line)).map(line => line.trim())])]
  const directories = desktopDataDirectories(env.HOME ?? homedir(), env)
  const locale = (env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '').replace(/\..*$/, '')
  const applications: NativeFileApplication[] = []
  for (const id of ids) {
    signal.throwIfAborted()
    let entryPath: string | null = null
    for (const directory of directories) {
      entryPath = await desktopFile(join(directory, 'applications'), id)
      if (entryPath !== null) break
    }
    if (entryPath === null) continue
    const fields = desktopEntryFields(await readFile(entryPath, 'utf8'))
    const name = fields[`Name[${locale}]`] ?? fields[`Name[${locale.replace(/_.*/, '')}]`] ?? fields.Name
    if (name === undefined || fields.Hidden === 'true') continue
    const icon = fields.Icon === undefined ? null : await desktopApplicationIcon(fields.Icon, directories)
    applications.push({ id: entryPath, name, default: id === preferred,
      icon: icon === null ? null : `data:${icon.contentType};base64,${icon.bytes.toString('base64')}` })
  }
  return applications
}
