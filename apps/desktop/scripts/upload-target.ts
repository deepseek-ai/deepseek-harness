/** Upload one validated Desktop release to its Tencent COS update directory. */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { DesktopPackageTargetName } from './package-target.ts'
import {
  createDesktopUploadPlan,
  type DesktopUploadArtifact,
} from './desktop-upload-plan.ts'

const SUPPORTED_TARGETS = new Set<DesktopPackageTargetName>(['mac-arm64', 'mac-x64', 'win-x64'])

function targetName(value: string): DesktopPackageTargetName {
  if (!SUPPORTED_TARGETS.has(value as DesktopPackageTargetName)) {
    throw new Error(`desktop upload: unsupported target ${JSON.stringify(value)}; expected ${[...SUPPORTED_TARGETS].join(', ')}`)
  }
  return value as DesktopPackageTargetName
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop upload: ${name} must be set to a non-empty value`)
  }
  return value
}

async function putArtifact(
  client: S3Client,
  bucket: string,
  artifact: DesktopUploadArtifact,
): Promise<void> {
  const details = await stat(artifact.path)
  const body = createReadStream(artifact.path)
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: artifact.key,
      Body: body,
      ContentLength: details.size,
      ContentType: artifact.contentType,
      CacheControl: artifact.cacheControl,
    }))
  }
  finally {
    body.destroy()
  }
  process.stdout.write(`desktop upload: uploaded ${artifact.key}\n`)
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true })
  const target = positionals[0]
  if (target === undefined || positionals.length !== 1) {
    throw new Error('desktop upload: expected exactly one target')
  }
  const plan = await createDesktopUploadPlan(targetName(target))
  const client = new S3Client({
    region: 'Auto',
    endpoint: 'https://cos.ap-beijing.myqcloud.com',
    credentials: {
      accessKeyId: requiredEnvironmentValue(process.env, plan.secretIdEnvName),
      secretAccessKey: requiredEnvironmentValue(process.env, plan.secretKeyEnvName),
    },
  })
  process.stdout.write(`desktop upload: ${plan.target} ${plan.version} -> ${plan.publicUrl}\n`)
  try {
    for (const artifact of plan.artifacts) await putArtifact(client, plan.bucket, artifact)
  }
  finally {
    client.destroy()
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
