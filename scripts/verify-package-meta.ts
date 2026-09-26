/** Validate source locale metadata, Node resource exports, and package publication selections. */

import { globSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, matchesGlob, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPluginMeta, resolvePluginResource } from '../packages/boot/app-boot/src/package-meta.ts'

interface Manifest {
  name: string
  exports?: unknown
  files?: string[]
  icon?: unknown
}

interface SourceJson {
  file: string
  metadata: boolean
  invalid: boolean
  icon?: unknown
}

function sourceJsonFiles(dir: string): SourceJson[] {
  return globSync('**/*.json', { cwd: dir, exclude: ['node_modules', 'lib', 'tests'] }).map((path) => {
    const file = path.replaceAll('\\', '/')
    let contents: unknown
    try {
      contents = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch (_error) {
      return { file, metadata: false, invalid: true }
    }
    if (typeof contents !== 'object' || contents === null || Array.isArray(contents)) {
      return { file, metadata: false, invalid: true }
    }
    return { file, metadata: Object.hasOwn(contents, 'meta'), invalid: false, icon: 'icon' in contents ? contents.icon : undefined }
  })
}

function targetsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(targetsOf)
}

// Target matching discovers resource requests; Node selects conditions, arrays, and export precedence.
function substitution(pattern: string, file: string): string | undefined {
  const index = pattern.indexOf('*')
  if (index < 0) return pattern === file ? '' : undefined
  const count = pattern.split('*').length - 1
  const width = (file.length - pattern.length + count) / count
  if (width < 0 || !Number.isInteger(width)) return undefined
  const value = file.slice(index, index + width)
  return pattern.replaceAll('*', value) === file ? value : undefined
}

function pluginOf(resource: string): string | undefined {
  return /^(\..*)\/locale\/[^/]+\.json$/u.exec(resource)?.[1]
}

function published(file: string, files: string[]): boolean {
  const covered = (pattern: string): boolean => {
    const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
    return normalized === '.' || normalized === ''
      || matchesGlob(file, normalized) || matchesGlob(file, `${normalized}/**`)
  }
  return files.some(pattern => !pattern.startsWith('!') && covered(pattern))
    && !files.some(pattern => pattern.startsWith('!') && covered(pattern.slice(1)))
}

function packageProblems(manifestPath: string): string[] {
  const problems: string[] = []
  const dir = realpathSync(dirname(manifestPath))
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
  const documents = sourceJsonFiles(dir)
  const byPath = new Map(documents.map(document => [join(dir, document.file), document]))
  const parentURL = pathToFileURL(join(dir, 'package.json')).href
  const specifierOf = (plugin: string): string => pkg.name + (plugin === '.' ? '' : plugin.slice(1))
  const candidates = new Set(['.'])
  const alternatives = new Map<string, Set<string>>()
  const exported = typeof pkg.exports === 'object' && pkg.exports !== null ? Object.entries(pkg.exports) : []
  for (const [key, target] of exported) {
    if (!key.startsWith('.')) continue
    if (!key.includes('*')) {
      candidates.add(key)
      if (key.endsWith('/package.json')) candidates.add(key.slice(0, -'/package.json'.length))
    }
    const plugin = pluginOf(key)
    if (plugin !== undefined && !plugin.includes('*')) candidates.add(plugin)
    for (const pattern of targetsOf(target)) {
      for (const document of documents) {
        const value = substitution(pattern, `./${document.file}`)
        if (value === undefined) continue
        const request = key.replaceAll('*', value)
        if (request.endsWith('/package.json')) candidates.add(request.slice(0, -'/package.json'.length))
        const owner = pluginOf(request)
        if (owner === undefined) continue
        candidates.add(owner)
        let requests = alternatives.get(document.file)
        if (requests === undefined) alternatives.set(document.file, requests = new Set())
        requests.add(pkg.name + request.slice(1))
      }
    }
  }

  const resolved = new Map<string, string | undefined>()
  const lookup = (resource: string): string | undefined => {
    if (!resolved.has(resource)) {
      try {
        resolved.set(resource, resolvePluginResource(resource, parentURL))
      } catch (_error) {
        // Missing exports and files are diagnosed against their source metadata below.
        resolved.set(resource, undefined)
      }
    }
    return resolved.get(resource)
  }
  const filenames = new Set(['en.json', ...documents.map(document => basename(document.file))])
  const claimed = new Set<string>()
  for (const candidate of candidates) {
    const specifier = specifierOf(candidate)
    const resourceOf = (filename: string): string => `${specifier}/locale/${filename}`
    const resources = [...filenames].flatMap((filename) => {
      const file = lookup(resourceOf(filename))
      return file === undefined ? [] : [{ filename, file }]
    })
    const iconManifest = lookup(`${specifier}/package.json`)
    const iconDocument = iconManifest === undefined ? undefined : byPath.get(iconManifest)
    let iconChecked = false
    if (candidate === '.' && pkg.icon !== undefined && iconManifest !== join(dir, 'package.json')) {
      problems.push(`${manifestPath}: exports must expose its icon declaration through ${pkg.name}/package.json`)
    }
    if (iconDocument?.icon !== undefined && resources.every(({ file }) => byPath.has(file))) {
      iconChecked = true
      const meta = readPluginMeta(specifier, parentURL)
      if (meta?.error !== undefined) problems.push(meta.error)
      if (meta?.icon !== undefined && typeof iconDocument.icon === 'string') {
        const iconFile = relative(dir, resolve(dirname(join(dir, iconDocument.file)), iconDocument.icon)).replaceAll('\\', '/')
        if (pkg.files !== undefined && !published(iconFile, pkg.files)) problems.push(`${manifestPath}: files must include ${iconFile}`)
        if (iconDocument.file !== 'package.json' && pkg.files !== undefined && !published(iconDocument.file, pkg.files)) {
          problems.push(`${manifestPath}: files must include ${iconDocument.file}`)
        }
      }
    } else if (iconDocument?.icon !== undefined) {
      problems.push(`${specifier}: icon metadata requires locale resources to resolve to source JSON`)
    }
    if (!resources.some(({ file }) => byPath.get(file)?.metadata || byPath.get(file)?.invalid)) continue
    for (const { file } of resources) claimed.add(file)
    const english = lookup(resourceOf('en.json'))
    if (english === undefined) {
      problems.push(`${manifestPath}: exports must provide ${resourceOf('en.json')} as the locale discovery baseline`)
      continue
    }
    if (!byPath.has(english)) {
      problems.push(`${resourceOf('en.json')}: English metadata must resolve to source JSON, received ${english}`)
      continue
    }
    const directory = dirname(english)
    let sourceResources = true
    for (const { filename, file } of resources) {
      if (!byPath.has(file)) {
        problems.push(`${resourceOf(filename)}: locale metadata must resolve to source JSON, received ${file}`)
        sourceResources = false
      }
      if (dirname(file) !== directory) {
        problems.push(`${resourceOf(filename)}: ${file} must share the English locale directory ${directory}`)
      }
    }
    if (sourceResources && !iconChecked) {
      const meta = readPluginMeta(specifier, parentURL)
      if (meta?.error !== undefined) problems.push(meta.error)
    }
    for (const document of documents.filter(document => dirname(join(dir, document.file)) === directory)) {
      const resource = resourceOf(basename(document.file))
      const file = lookup(resource)
      if (file === undefined) {
        problems.push(`${manifestPath}: exports must expose ${resource} (${document.file})`)
      } else if (file !== join(dir, document.file)) {
        problems.push(`${manifestPath}: exports for ${resource} must resolve to ${document.file}, received ${relative(dir, file)}`)
      }
      if (pkg.files !== undefined && !published(document.file, pkg.files)) {
        problems.push(`${manifestPath}: files must include ${document.file}`)
      }
    }
  }

  for (const document of documents) {
    const requests = alternatives.get(document.file)
    if (!document.file.split('/').includes('locale') && requests === undefined) continue
    if (!document.metadata && !document.invalid) continue
    if (claimed.has(join(dir, document.file))) continue
    if (requests !== undefined && [...requests].some((resource) => {
      const selected = lookup(resource)
      return selected !== undefined && byPath.has(selected)
    })) continue
    problems.push(`${manifestPath}: exports must expose ${document.file} as a plugin locale resource with an en.json discovery baseline`)
  }
  return problems
}

/**
 * Check static plugin locale metadata and resource publication without evaluating plugin entries or reading built output.
 * @param root - repository or fixture root.
 * @returns diagnostics for an empty package corpus, invalid metadata, inaccessible resources, or omitted publication files.
 */
export function packageMetaProblems(root: string): string[] {
  const manifests = globSync('packages/*/*/package.json', { cwd: root }).map(path => path.replaceAll('\\', '/'))
  if (manifests.length === 0) return [`${root}: no workspace package manifests found`]
  return manifests.flatMap(path => packageProblems(join(root, path)))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = packageMetaProblems(resolve(import.meta.dirname, '..'))
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else {
    console.log('verify-package-meta: plugin locale metadata, resource exports, and publication files are valid.')
  }
}
