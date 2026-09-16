/** One-time removal of package links recorded by Desktop profile management. */

import { lstatSync, readFileSync, readlinkSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Legacy Desktop package-link ownership file. */
export const DESKTOP_PROFILE_STATE = 'desktop-runtime-state.json'

interface DesktopPackageLink {
  readonly name: string
  readonly target: string
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

/**
 * Remove recorded links still owned by Desktop and delete their legacy state file.
 * Installed directories, changed links, and links beneath redirected package directories are retained.
 * @param profile - Desktop profile directory.
 */
export function migrateDesktopProfileLinks(profile: string): void {
  const statePath = join(profile, DESKTOP_PROFILE_STATE)
  if (stat(statePath) === undefined) return
  const value: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!record(value) || !Array.isArray(value.links)) throw new Error('desktop profile: invalid legacy package links')
  const links = value.links.map((link: unknown): DesktopPackageLink => {
    if (!record(link) || typeof link.name !== 'string' || !PACKAGE_NAME.test(link.name)
      || typeof link.target !== 'string' || !isAbsolute(link.target)) {
      throw new Error('desktop profile: invalid legacy package link')
    }
    return { name: link.name, target: link.target }
  })
  const modules = join(profile, 'node_modules')
  if (stat(modules)?.isDirectory() === true) {
    for (const link of links) {
      const path = join(modules, link.name)
      if (dirname(path) !== modules && stat(dirname(path))?.isDirectory() !== true) continue
      if (stat(path)?.isSymbolicLink() === true
        && resolve(dirname(path), readlinkSync(path)) === resolve(link.target)) {
        unlinkSync(path)
      }
    }
  }
  unlinkSync(statePath)
}
