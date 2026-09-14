/** Experimental ownership of the actual filesystem and package inputs supplied to a bundler. */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package identities are cached only within one build. */
export class BundleInputIsolation {
  private readonly packages = new Map<string, string | undefined>()
  private readonly repository: string
  private readonly label: string

  constructor(repository: string, label: string) {
    this.repository = repository
    this.label = label
  }

  /** Discard package metadata before a new build or watch rebuild. */
  reset(): void { this.packages.clear() }

  /**
   * Require a recorded input to have non-experimental physical and package ownership.
   * @param id - bundler module id, filesystem path, or filesystem URL.
   */
  assertInput(id: string): void {
    this.checkInput(id, false)
  }

  /**
   * Check declared source-map ownership; dependency tarballs may omit their upstream sources.
   * @param id - source-map source resolved relative to its map.
   */
  assertSourceMapInput(id: string): void {
    this.checkInput(id, true)
  }

  private checkInput(id: string, allowMissing: boolean): void {
    if (/(?:^|[/:\u0000])@deepseek-ai\/dsh-experimental-[^/?#]+/.test(id)) {
      throw new Error(`${this.label}: experimental input ${id}`)
    }
    const file = physicalBundleInput(id)
    if (file === undefined) return
    const lexical = relative(resolve(this.repository, 'packages/experimental'), file)
    if (lexical === '' || lexical !== '..' && !lexical.startsWith(`..${sep}`) && !isAbsolute(lexical)) {
      throw new Error(`${this.label}: experimental input ${id}`)
    }
    let existing = file
    if (!allowMissing && !existsSync(file)) throw new Error(`${this.label}: input ${id} is missing`)
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) throw new Error(`${this.label}: input ${id} has no existing filesystem root`)
      existing = parent
    }
    const canonical = resolve(realpathSync(existing), relative(existing, file))
    if (canonical !== file) this.checkInput(canonical, allowMissing)
    const name = this.packageName(dirname(canonical))
    if (name?.startsWith('@deepseek-ai/dsh-experimental-')) {
      throw new Error(`${this.label}: ${id} belongs to experimental package ${name}`)
    }
  }

  private packageName(directory: string): string | undefined {
    if (this.packages.has(directory)) return this.packages.get(directory)
    const manifest = resolve(directory, 'package.json')
    let name: string | undefined
    if (existsSync(manifest)) {
      const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      if (value !== null && typeof value === 'object' && 'name' in value && typeof value.name === 'string') name = value.name
    }
    if (name === undefined && dirname(directory) !== directory) name = this.packageName(dirname(directory))
    this.packages.set(directory, name)
    return name
  }
}

/**
 * Recover physical ownership from queries, filesystem URLs, and virtual path wrappers.
 * @param id - bundler module id or recorded filesystem input.
 * @returns absolute file path, or undefined for a virtual id without a physical path.
 */
export function physicalBundleInput(id: string): string | undefined {
  let clean = id.replaceAll('\\', '/').split(/[?#]/, 1)[0] ?? ''
  clean = clean.replace(/^\u0000/, '')
  if (clean.startsWith('file://')) return fileURLToPath(clean)
  if (clean.startsWith('/@fs/')) {
    clean = clean.slice('/@fs/'.length)
    if (!isAbsolute(clean) && !/^[a-zA-Z]:\//.test(clean)) clean = `/${clean}`
  }
  if (!isAbsolute(clean) && !/^[a-zA-Z]:\//.test(clean)) {
    const wrapped = /:(\/.*|[a-zA-Z]:\/.*)$/.exec(clean)?.[1]
    if (wrapped === undefined) return undefined
    clean = wrapped
  }
  return resolve(clean)
}
