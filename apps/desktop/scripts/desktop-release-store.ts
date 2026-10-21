/** Retain immutable Desktop build files outside disposable runner checkouts. */
import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { z } from 'zod'

const positiveId = z.string().regex(/^[1-9]\d*$/u)
const filename = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
const sourceSchema = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  runId: positiveId,
  attempt: positiveId,
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  workflowCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceRef: z.string().min(1),
  channel: z.enum(['nightly', 'latest']),
  runnerName: z.string().min(1),
  // Storage accepts every Desktop target; CI routing separately limits currently provisioned platforms.
  target: z.enum(['mac-arm64', 'mac-x64', 'win-x64']),
  preset: z.enum(['test', 'production']),
  productVersion: z.string().min(1),
  version: z.string().min(1),
  testReleaseId: z.string().regex(/^[a-f0-9]{32}$/u).nullable(),
  // Older retained manifests carry this flag; manual publication does not depend on it.
  publishRequested: z.boolean().optional(),
  qualification: z.enum(['signed', 'notarized', 'unsigned', 'unnotarized']),
}).refine(source => source.preset === 'test' || /^(?:master|dsh-v[0-9][0-9A-Za-z.-]*)$/u.test(source.sourceRef),
  'Production source must be master or dsh-v*')
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: sourceSchema,
  files: z.array(z.strictObject({ name: filename, size: z.number().int().positive(),
    sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u) })).min(1),
})

/** Public, credential-free identity of one packaging attempt. */
export type DesktopRetainedSource = z.infer<typeof sourceSchema>
/** File inventory bound to the source packaging attempt. */
export type DesktopRetainedManifest = z.infer<typeof manifestSchema>

async function fingerprint(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('desktop release store: expected a regular file')
  const hash = createHash('sha512')
  let size = 0
  for await (const bytes of createReadStream(path)) { size += bytes.length; hash.update(bytes) }
  if (size === 0) throw new Error('desktop release store: empty artifact')
  return { size, sha512: hash.digest('base64') }
}

async function directory(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('desktop release store: expected a real directory')
  return realpath(path)
}

/**
 * Resolve an attempt beneath an absolute, machine-owned releases root.
 * @param root Persistent releases directory, outside the checkout.
 * @param runId GitHub packaging run ID.
 * @param attempt Packaging attempt, not the publishing attempt.
 * @returns Deterministic path after validating both identifiers.
 */
export function retainedDesktopPath(root: string, runId: string, attempt: string): string {
  if (!isAbsolute(root)) throw new Error('desktop release store: root must be absolute')
  positiveId.parse(runId)
  positiveId.parse(attempt)
  return join(root, runId, attempt)
}

/**
 * Copy an explicit file inventory, verify the copies, then expose one complete attempt atomically.
 * @param root Persistent releases root owned by this runner.
 * @param source Packaging identity and selected public settings.
 * @param paths Complete artifact and completion-record paths; directory trees are not accepted.
 * @returns Published attempt directory. An existing attempt is never replaced.
 */
export async function retainDesktopRelease(root: string, source: DesktopRetainedSource, paths: readonly string[]): Promise<string> {
  sourceSchema.parse(source)
  const destination = retainedDesktopPath(root, source.runId, source.attempt)
  const names = paths.map(path => filename.parse(basename(path)))
  if (names.length === 0 || new Set(names).size !== names.length) throw new Error('desktop release store: empty or duplicate file inventory')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await directory(root)
  const parent = join(root, source.runId)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await directory(parent)
  const claim = join(parent, `${source.attempt}.lock`)
  await mkdir(claim, { mode: 0o700 })
  let staging: string | undefined
  try {
    try {
      await lstat(destination)
      throw new Error('desktop release store: attempt already exists')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    staging = await mkdtemp(join(parent, '.retaining-'))
    const files = []
    for (const path of paths) {
      const name = basename(path)
      if (name === 'manifest.json') throw new Error('desktop release store: manifest filename is reserved')
      const before = await fingerprint(path)
      const copied = join(staging, name)
      await copyFile(path, copied, constants.COPYFILE_EXCL)
      const after = await fingerprint(copied)
      if (before.size !== after.size || before.sha512 !== after.sha512) throw new Error('desktop release store: source changed during retention')
      files.push({ name, ...after })
    }
    const manifest: DesktopRetainedManifest = { schemaVersion: 1, source, files }
    manifestSchema.parse(manifest)
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true })
    await rename(staging, destination)
    staging = undefined
    return destination
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true })
    await rm(claim, { recursive: true })
  }
}

/**
 * Read an attempt and rehash every retained file before a consumer uses it.
 * @param root Persistent releases root.
 * @param runId Expected source run ID.
 * @param attempt Expected source attempt.
 * @returns Parsed inventory; missing, linked, changed or mismatched files reject.
 */
export async function verifyRetainedDesktopRelease(root: string, runId: string, attempt: string): Promise<DesktopRetainedManifest> {
  const path = retainedDesktopPath(root, runId, attempt)
  await directory(root)
  await directory(join(root, runId))
  await directory(path)
  const manifestPath = join(path, 'manifest.json')
  if (!(await lstat(manifestPath)).isFile() || (await lstat(manifestPath)).isSymbolicLink()) throw new Error('desktop release store: invalid manifest file')
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (manifest.source.runId !== runId || manifest.source.attempt !== attempt) throw new Error('desktop release store: attempt identity mismatch')
  if (new Set(manifest.files.map(file => file.name)).size !== manifest.files.length) throw new Error('desktop release store: duplicate file inventory')
  for (const file of manifest.files) {
    const current = await fingerprint(join(path, file.name))
    if (current.size !== file.size || current.sha512 !== file.sha512) throw new Error(`desktop release store: changed file ${file.name}`)
  }
  return manifest
}
