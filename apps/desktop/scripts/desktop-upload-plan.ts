/** Validate packaged Desktop update artifacts before any network upload begins. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import type { DesktopPackageTargetName } from './package-target.ts'
import {
  desktopBuildRecordFilename,
  desktopUpdateMetadataFilename,
  resolveDesktopUploadConfig,
} from './desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const TARGETS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64', os: 'mac' },
  'mac-x64': { platform: 'darwin', arch: 'x64', os: 'mac' },
  'win-x64': { platform: 'win32', arch: 'x64', os: 'win' },
} as const satisfies Record<DesktopPackageTargetName, {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly os: string
}>

/** One local file and its final object metadata. */
export interface DesktopUploadArtifact {
  readonly path: string
  readonly filename: string
  readonly key: string
  readonly contentType: string
  readonly cacheControl: string
  readonly channelMetadata: boolean
}

/** A fully validated upload operation with channel metadata ordered last. */
export interface DesktopUploadPlan {
  readonly environment: 'test' | 'production'
  readonly target: DesktopPackageTargetName
  readonly version: string
  readonly publicUrl: string
  readonly bucket: string
  readonly secretIdEnvName: string
  readonly secretKeyEnvName: string
  readonly artifacts: readonly DesktopUploadArtifact[]
}

/** Filesystem and environment inputs used to validate one upload. */
export interface DesktopUploadPlanOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly repositoryRoot?: string
  readonly appRoot?: string
  readonly artifactsRoot?: string
}

interface UpdateFileInfo {
  readonly filename: string
  readonly size: number
  readonly sha512: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop upload: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`desktop upload: ${label} must be a non-empty string`)
  }
  return value
}

function numberField(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`desktop upload: ${label} must be a positive integer`)
  }
  return value
}

async function jsonFile(path: string, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new Error(`desktop upload: cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return object(parsed, label)
}

async function manifestVersion(path: string, label: string): Promise<string> {
  return stringField((await jsonFile(path, label)).version, `${label}.version`)
}

function updateFileInfo(value: unknown, label: string, expectedFilename: string): UpdateFileInfo {
  const info = object(value, label)
  const filename = stringField(info.url ?? info.path, `${label}.url`)
  if (filename !== basename(filename) || filename !== expectedFilename) {
    throw new Error(`desktop upload: ${label} must reference ${expectedFilename}, received ${filename}`)
  }
  return {
    filename,
    size: numberField(info.size, `${label}.size`),
    sha512: stringField(info.sha512, `${label}.sha512`),
  }
}

async function sha512(path: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

async function verifyChecksummedArtifact(
  artifactsRoot: string,
  info: UpdateFileInfo,
): Promise<string> {
  const path = join(artifactsRoot, info.filename)
  const details = await stat(path).catch(() => undefined)
  if (details === undefined || !details.isFile()) {
    throw new Error(`desktop upload: missing artifact ${path}`)
  }
  if (details.size !== info.size) {
    throw new Error(`desktop upload: ${info.filename} size ${details.size} does not match update metadata ${info.size}`)
  }
  const actual = await sha512(path)
  if (actual !== info.sha512) {
    throw new Error(`desktop upload: ${info.filename} SHA-512 does not match update metadata`)
  }
  return path
}

async function requireArtifact(artifactsRoot: string, filename: string): Promise<string> {
  const path = join(artifactsRoot, filename)
  const details = await stat(path).catch(() => undefined)
  if (details === undefined || !details.isFile() || details.size === 0) {
    throw new Error(`desktop upload: missing or empty artifact ${path}`)
  }
  return path
}

function uploadArtifact(
  path: string,
  keyPrefix: string,
  contentType: string,
  channelMetadata = false,
): DesktopUploadArtifact {
  const filename = basename(path)
  return {
    path,
    filename,
    key: `${keyPrefix}/${filename}`,
    contentType,
    cacheControl: channelMetadata
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
    channelMetadata,
  }
}

/**
 * Validate the completed package record, dsh version, update metadata, hashes, and target files.
 * @param targetName - Fixed platform and architecture selected by the upload command.
 * @param options - Optional filesystem roots and environment for tests or release automation.
 * @returns An upload plan whose mutable channel metadata is the final entry.
 */
export async function createDesktopUploadPlan(
  targetName: DesktopPackageTargetName,
  options: DesktopUploadPlanOptions = {},
): Promise<DesktopUploadPlan> {
  const target = TARGETS[targetName]
  if (target === undefined) {
    throw new Error(`desktop upload: unsupported target ${String(targetName)}`)
  }
  const environment = options.environment ?? process.env
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT
  const appRoot = options.appRoot ?? APP_ROOT
  const artifactsRoot = options.artifactsRoot ?? desktopTargetBuildPaths(targetName).artifacts
  const dshVersion = await manifestVersion(join(repositoryRoot, 'package.json'), 'dsh package')
  const desktopVersion = await manifestVersion(join(appRoot, 'package.json'), 'desktop package')
  if (dshVersion !== desktopVersion) {
    throw new Error(`desktop upload: desktop version ${desktopVersion} does not match current dsh version ${dshVersion}`)
  }

  const update = resolveDesktopUploadConfig(environment, target.platform, target.arch)
  const buildRecord = await jsonFile(
    join(artifactsRoot, desktopBuildRecordFilename(targetName)),
    `${targetName} package completion record`,
  )
  if (buildRecord.schemaVersion !== 1
    || buildRecord.target !== targetName
    || buildRecord.version !== dshVersion
    || buildRecord.environment !== update.environment
    || buildRecord.publicUrl !== update.publicUrl) {
    throw new Error(`desktop upload: ${targetName} package completion record does not match dsh ${dshVersion} and ${update.environment} update destination`)
  }

  const metadataFilename = desktopUpdateMetadataFilename(dshVersion, target.platform)
  const metadataPath = join(artifactsRoot, metadataFilename)
  let metadataValue: unknown
  try {
    metadataValue = load(await readFile(metadataPath, 'utf8'))
  }
  catch (error) {
    throw new Error(`desktop upload: cannot read update metadata at ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const metadata = object(metadataValue, metadataFilename)
  const metadataVersion = stringField(metadata.version, `${metadataFilename}.version`)
  if (metadataVersion !== dshVersion) {
    throw new Error(`desktop upload: ${metadataFilename} version ${metadataVersion} does not match current dsh version ${dshVersion}`)
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error(`desktop upload: ${metadataFilename}.files must contain exactly one target update file`)
  }

  const base = `deepseek-harness-${dshVersion}-${target.os}-${target.arch}`
  const updaterExtension = target.platform === 'darwin' ? 'zip' : 'exe'
  const updaterInfo = updateFileInfo(metadata.files[0], `${metadataFilename}.files[0]`, `${base}.${updaterExtension}`)
  const updaterPath = await verifyChecksummedArtifact(artifactsRoot, updaterInfo)
  const artifacts: DesktopUploadArtifact[] = []

  if (target.platform === 'darwin') {
    const dmgPath = await requireArtifact(artifactsRoot, `${base}.dmg`)
    const blockmapPath = await requireArtifact(artifactsRoot, `${base}.zip.blockmap`)
    artifacts.push(
      uploadArtifact(dmgPath, update.keyPrefix, 'application/x-apple-diskimage'),
      uploadArtifact(updaterPath, update.keyPrefix, 'application/zip'),
      uploadArtifact(blockmapPath, update.keyPrefix, 'application/octet-stream'),
    )
  }
  else {
    const blockMapSize = object(metadata.files[0], `${metadataFilename}.files[0]`).blockMapSize
    numberField(blockMapSize, `${metadataFilename}.files[0].blockMapSize`)
    artifacts.push(uploadArtifact(
      updaterPath,
      update.keyPrefix,
      'application/vnd.microsoft.portable-executable',
    ))
  }

  artifacts.push(uploadArtifact(metadataPath, update.keyPrefix, 'application/yaml', true))
  return {
    environment: update.environment,
    target: targetName,
    version: dshVersion,
    publicUrl: update.publicUrl,
    bucket: update.bucket,
    secretIdEnvName: update.secretIdEnvName,
    secretKeyEnvName: update.secretKeyEnvName,
    artifacts,
  }
}
