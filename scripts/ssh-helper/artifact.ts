/** Versioned archive metadata and file integrity checks for SSH helper releases. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { z } from 'zod'

/** Native target identifiers accepted by the builder and release workflow. */
export const SSH_HELPER_TARGETS = ['node24-linux-x64', 'node24-linux-arm64', 'node24-macos-x64', 'node24-macos-arm64'] as const
/** One qualified OS and architecture for a bundled Node 24 helper. */
export type SshHelperTarget = typeof SSH_HELPER_TARGETS[number]

const payloadPath = z.string().min(1).refine(value =>
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'invalid payload path')

/** Parser for metadata supplied beside an executable, including every runtime resource. */
export const artifactManifestSchema = z.object({
  format: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  dirty: z.boolean(),
  target: z.enum(SSH_HELPER_TARGETS),
  protocol: z.number().int().positive(),
  nodeVersion: z.string().regex(/^v24\./),
  files: z.array(z.object({
    path: payloadPath, sha256: z.string().regex(/^[a-f0-9]{64}$/), mode: z.number().int().min(0).max(0o777),
  }).strict()).min(1),
}).strict()

/** Results written by the isolated Loader consumer after its assertions succeed. */
export const runtimeReportSchema = z.object({
  checks: z.array(z.string()), platform: z.enum(['linux', 'darwin']), nodeVersion: z.string(),
  sandboxLane: z.enum(['required', 'unavailable', 'portable']),
}).strict()

/** Parsed release metadata; files excludes manifest.json to avoid a self-referential digest. */
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>

/**
 * Enumerate an owned payload without following links outside its directory.
 * @param root - unpacked payload directory.
 * @returns sorted POSIX relative file paths, excluding manifest.json.
 */
export async function payloadFiles(root: string): Promise<string[]> {
  const paths: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`SSH helper payload contains a symbolic link: ${path}`)
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) paths.push(relative(root, path).split(sep).join('/'))
      else throw new Error(`SSH helper payload contains a non-regular file: ${path}`)
    }
  }
  await visit(root)
  return paths.filter(path => path !== 'manifest.json').sort()
}

/**
 * Hash the exact file bytes used for installation or publication.
 * @param path - regular file path.
 * @returns lowercase SHA-256.
 */
export async function fileDigest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Verify all payload bytes and permissions before running an unpacked release.
 * @param directory - unpacked payload root.
 * @returns the validated metadata; missing, duplicate, extra, or altered files reject.
 */
export async function verifyPayload(directory: string): Promise<ArtifactManifest> {
  const manifest = artifactManifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
  const actual = await payloadFiles(directory)
  const declared = manifest.files.map(file => file.path).sort()
  if (new Set(declared).size !== declared.length || JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw new Error('SSH helper payload file inventory differs from manifest.json')
  }
  if (!declared.includes('dsh-ssh-helper') || !declared.includes('native/system/package.json')) throw new Error('SSH helper payload omits required runtime files')
  for (const file of manifest.files) {
    const path = join(directory, file.path)
    if (await fileDigest(path) !== file.sha256) throw new Error(`SSH helper payload digest differs: ${file.path}`)
    if (((await lstat(path)).mode & 0o777) !== file.mode) throw new Error(`SSH helper payload permissions differ: ${file.path}`)
  }
  return manifest
}
