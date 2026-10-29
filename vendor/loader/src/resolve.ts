import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import type { Dict } from '@deepseek-ai/cosmokit'

/** Resolve a specifier to its URL in one configuration project. */
export type Resolve = (specifier: string) => string

// Order matters: the directory ignores itself before the helper appears in it.
const HELPER_FILES = {
  '.gitignore': '# created by cordis automatically\n*\n',
  // The one-argument form of `import.meta.resolve` anchors on this file, so
  // resolution happens in the project scope. A resolve call also survives a
  // bundling host, which transforms modules inside its root and redirects the
  // `import()` in them to its own resolver.
  'resolve.mjs': 'export default (specifier) => import.meta.resolve(specifier)\n',
}

const cache: Dict<Promise<Resolve | undefined>> = Object.create(null)

/** Nearest ancestor of `dir` that owns a `package.json`, if any. */
function findScope(dir: string) {
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

function resolveScope(baseUrl: string | undefined) {
  if (!baseUrl) return
  let dir: string
  try {
    dir = url.fileURLToPath(new URL('.', baseUrl))
  } catch {
    return
  }
  return findScope(path.resolve(dir))
}

async function write(filename: string, content: string) {
  // Another process may be writing the same path; `rename` is atomic, so a
  // concurrent reader only ever observes the complete helper.
  const temp = `${filename}.${process.pid}`
  await fsPromises.writeFile(temp, content)
  await fsPromises.rename(temp, filename)
}

async function _createResolve(scope: string): Promise<Resolve | undefined> {
  const dir = path.join(scope, '.cordis')
  try {
    await fsPromises.mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(HELPER_FILES)) {
      await write(path.join(dir, name), content)
    }
  } catch {
    // Read-only filesystems are legitimate; the caller falls back to a native `import()`.
    return
  }
  const helperUrl = url.pathToFileURL(path.join(dir, 'resolve.mjs')).href
  return (await import(/* @vite-ignore */ helperUrl)).default
}

/**
 * Create or reuse a native ESM resolver anchored in the config project's package scope.
 * @param baseUrl Config file URL; absent, non-file or unscoped URLs cannot supply a resolver.
 * @returns The project resolver, or undefined when no package scope exists or its helper cannot be written.
 */
export async function createResolve(baseUrl: string | undefined) {
  const scope = resolveScope(baseUrl)
  if (!scope) return
  return await (cache[scope] ??= _createResolve(scope))
}
