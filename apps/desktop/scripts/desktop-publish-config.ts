/** Read public deployment settings independently from upload and GitHub App secrets. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

const singleLine = z.string().min(1).regex(/^[^\r\n\0]+$/u, 'expected a single-line value')
const absolutePath = singleLine.refine(isAbsolute, 'expected an absolute path')
const schema = z.strictObject({
  bucket: z.string().regex(/^[a-z0-9-]+-\d+$/u),
  origin: z.url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash }, 'expected an HTTPS origin'),
  credentialsFile: absolutePath,
  macOS: z.strictObject({ signingIdentity: z.string().min(1), teamId: z.string().regex(/^[A-Z0-9]{10}$/u) }).optional(),
  windows: z.strictObject({ certificateThumbprint: z.string().regex(/^[A-Fa-f0-9]{40}$/u) }).optional(),
  githubApp: z.strictObject({ clientId: singleLine, privateKeyFile: absolutePath }).optional(),
})
/** Public machine configuration; all secret fields are file references. */
export type DesktopPublishConfig = z.infer<typeof schema>

/**
 * Read one named deployment without opening referenced credential files.
 * @param configRoot Absolute machine packaging configuration directory.
 * @param preset Selected deployment from the retained package.
 * @returns Validated public configuration; production requires App configuration.
 */
export async function readDesktopPublishConfig(configRoot: string, preset: 'test' | 'production'): Promise<DesktopPublishConfig> {
  if (!isAbsolute(configRoot)) throw new Error('desktop publish: configuration root must be absolute')
  const config = schema.parse(JSON.parse(await readFile(join(configRoot, 'publishing', `${preset}.json`), 'utf8')))
  if (preset === 'production' && (config.origin !== 'https://download.deepseek.com' || !config.githubApp)) {
    throw new Error('desktop publish: production requires its fixed origin and GitHub App configuration')
  }
  return config
}

/**
 * Read upload credentials only after authorization and local validation have passed.
 * @param config Previously validated public deployment configuration.
 * @returns Explicit COS credential pair; contents never enter audit records.
 */
export async function readDesktopUploadCredentials(config: DesktopPublishConfig): Promise<{ secretId: string; secretKey: string }> {
  try {
    return z.strictObject({ secretId: z.string().min(1), secretKey: z.string().min(1) })
      .parse(JSON.parse(await readFile(config.credentialsFile, 'utf8')))
  } catch {
    throw new Error('desktop publish: cannot read valid upload credentials from the configured file')
  }
}
