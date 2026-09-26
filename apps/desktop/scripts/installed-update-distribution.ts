/** Validate local qualification payload bytes and prepare separate binary and fixed-feed operations. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'

/** A local immutable object, with its final test-only destination and digest. */
export interface InstalledUpdateBinary {
  readonly path: string
  readonly key: string
  readonly size: number
  readonly sha512: string
}

/** File integrity does not establish signature, application identity, or authority to publish. */
export interface InstalledUpdateDistribution {
  readonly version: string
  readonly bucket: string
  readonly binaries: readonly InstalledUpdateBinary[]
  readonly feed: { readonly key: string; readonly url: string; readonly contents: string; readonly sha512: string }
  readonly verified: 'file-integrity-only'
  readonly publicationAuthorized: false
}

async function binary(path: string, key: string): Promise<InstalledUpdateBinary> {
  const file = await stat(path)
  if (!file.isFile() || file.size === 0) throw new Error('installed update: missing or empty binary material')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { path, key, size: file.size, sha512: hash.digest('base64') }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('installed update: invalid feed metadata')
  return value as Record<string, unknown>
}

/**
 * Check generated YAML against installer bytes and prepare one independent fixed-feed body per version.
 * @param manifest Original qualification run.json; test identity and destinations are revalidated.
 * @param version One of the run's two versions, never a version inferred from YAML.
 * @returns Read-only binary and feed plans; no credentials, network, signing, or installation are involved.
 */
export async function planInstalledUpdateDistribution(manifest: string, version: string): Promise<InstalledUpdateDistribution> {
  const run = await readInstalledUpdateRun(manifest)
  if (!run.versions.includes(version)) throw new Error('installed update: version is outside the qualification run')
  const directory = join(run.root, version, 'installer')
  const metadata = record(load(await readFile(join(directory, 'nightly.yml'), 'utf8')))
  if (metadata.version !== version || !Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error('installed update: feed must describe exactly the selected version and installer')
  }
  const info = record(metadata.files[0])
  const filename = `deepseek-harness-${version}-win-x64.exe`
  if (info.url !== filename || (metadata.path !== undefined && metadata.path !== filename)) {
    throw new Error('installed update: feed filename must identify the selected local Windows installer')
  }
  const installer = await binary(join(directory, filename), `${run.binPrefix}/${filename}`)
  if (info.size !== installer.size || info.sha512 !== installer.sha512
    || (metadata.sha512 !== undefined && metadata.sha512 !== installer.sha512)) {
    throw new Error('installed update: installer size or SHA-512 differs from the generated feed')
  }
  const blockmap = await binary(join(directory, `${filename}.blockmap`), `${run.binPrefix}/${filename}.blockmap`)
  if (metadata.releaseDate !== undefined && (typeof metadata.releaseDate !== 'string'
    || !Number.isFinite(Date.parse(metadata.releaseDate)))) throw new Error('installed update: invalid feed release date')
  const url = `${run.origin}/${installer.key}`
  const contents = dump({ version, files: [{ url, size: installer.size, sha512: installer.sha512 }],
    path: url, sha512: installer.sha512, ...(metadata.releaseDate === undefined ? {} : { releaseDate: metadata.releaseDate }) })
  return { version, bucket: run.bucket, binaries: [installer, blockmap],
    feed: { key: run.feedKey, url: `${run.origin}/${run.feedKey}`, contents,
      sha512: createHash('sha512').update(contents).digest('base64') },
    verified: 'file-integrity-only', publicationAuthorized: false }
}
