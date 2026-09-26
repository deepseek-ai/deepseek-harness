/** Freeze the built main, preload, renderer, and bootstrap files shared by a qualification version pair. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'

interface ApplicationFile { readonly path: string; readonly sha256: string }

async function applicationFiles(root: string, relative = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) files.push(...await applicationFiles(root, path))
    else if (entry.isFile()) files.push(path)
    else throw new Error('installed update: application links and special files cannot be frozen')
  }
  return files
}

/**
 * Copy only shipped application files and record their hashes; existing output refuses reuse.
 * @param manifest Original run manifest with completed bootstrap preparation.
 * @param source Desktop app directory containing freshly built lib and renderer files.
 * @returns Hash record, not dependency, signed-package, or boot qualification evidence.
 */
export async function prepareInstalledUpdateApplication(manifest: string, source: string): Promise<object> {
  const run = await readInstalledUpdateRun(manifest)
  const directory = join(run.root, 'application')
  await mkdir(directory)
  await writeFile(join(directory, 'started.json'), `${JSON.stringify({ time: new Date().toISOString() })}\n`, { flag: 'wx', flush: true })
  try {
    const modules = (await readdir(join(source, 'lib'), { withFileTypes: true }))
      .filter(entry => /\.(?:js|cjs)$/u.test(entry.name))
    if (modules.some(entry => !entry.isFile())) throw new Error('installed update: application modules must be regular files')
    const paths = [...modules.map(entry => `lib/${entry.name}`), ...await applicationFiles(source, 'renderer')].sort()
    for (const required of ['lib/main.js', 'lib/preload-app.cjs', 'lib/preload-mandatory.cjs', 'lib/preload-update-dialog.cjs']) {
      if (!paths.includes(required)) throw new Error('installed update: rebuild Desktop before freezing application files')
    }
    const files: ApplicationFile[] = []
    const inputs = [...paths.map(path => ({ path, source: join(source, path) })),
      ...['qualification-bootstrap.mjs', 'installed-update-identity.mjs'].map(path => ({ path, source: join(run.root, 'bootstrap', path) }))]
    for (const input of inputs) {
      const bytes = await readFile(input.source)
      const target = join(directory, 'files', input.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes, { flag: 'wx', flush: true })
      files.push({ path: input.path, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    for (const [index, input] of inputs.entries()) {
      if (createHash('sha256').update(await readFile(input.source)).digest('hex') !== files[index]!.sha256) {
        throw new Error('installed update: application input changed while freezing files')
      }
    }
    const result = { schemaVersion: 1, files, dependenciesFrozen: false, signed: false, bootTested: false }
    await writeFile(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', flush: true })
    return result
  } catch (error) {
    await writeFile(join(directory, 'failed.json'), `${JSON.stringify({ failed: true, retryAllowed: false })}\n`, { flag: 'wx', flush: true })
    throw error
  }
}

/**
 * Verify frozen application bytes before selecting them for a package.
 * @param root Validated run directory.
 * @returns The application file directory; node_modules and build hooks remain separate inputs.
 */
export async function verifyInstalledUpdateApplication(root: string): Promise<string> {
  const directory = join(root, 'application')
  const record = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as { schemaVersion?: unknown; files?: unknown }
  if (record.schemaVersion !== 1 || !Array.isArray(record.files) || record.files.length === 0) {
    throw new Error('installed update: missing application file inventory')
  }
  const paths = new Set<string>()
  for (const entry of record.files as unknown[]) {
    if (typeof entry !== 'object' || entry === null || !('path' in entry) || !('sha256' in entry)
      || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string'
      || entry.path.includes('\\') || entry.path.includes(':') || entry.path.split('/').some(part => ['', '.', '..'].includes(part))
      || !/^(?:lib\/[^/]+\.(?:js|cjs)|renderer\/.+|qualification-bootstrap\.mjs|installed-update-identity\.mjs)$/u.test(entry.path)
      || !/^[a-f0-9]{64}$/u.test(entry.sha256) || paths.has(entry.path)) {
      throw new Error('installed update: invalid application file inventory')
    }
    paths.add(entry.path)
    if (createHash('sha256').update(await readFile(join(directory, 'files', entry.path))).digest('hex') !== entry.sha256) {
      throw new Error('installed update: frozen application file changed')
    }
  }
  const actual = await applicationFiles(join(directory, 'files'))
  if (actual.length !== paths.size || actual.some(path => !paths.has(path))
    || ['lib/main.js', 'qualification-bootstrap.mjs', 'installed-update-identity.mjs'].some(path => !paths.has(path))) {
    throw new Error('installed update: frozen application inventory has missing or additional files')
  }
  return join(directory, 'files')
}
