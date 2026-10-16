import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readDesktopPublishConfig, readDesktopUploadCredentials } from '../scripts/desktop-publish-config.ts'

it('reads public settings without opening the absent credential file and requires production App settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publish-config-'))
  try {
    await mkdir(join(root, 'publishing'))
    const config = { bucket: 'test-1250000000', origin: 'https://example.com', credentialsFile: join(root, 'absent.json') }
    await writeFile(join(root, 'publishing/test.json'), JSON.stringify(config))
    const selected = await readDesktopPublishConfig(root, 'test')
    expect(selected).toEqual(config)
    await expect(readDesktopUploadCredentials(selected)).rejects.toThrow(/cannot read valid upload credentials/u)
    await writeFile(join(root, 'publishing/production.json'), JSON.stringify({ ...config, origin: 'https://download.deepseek.com' }))
    await expect(readDesktopPublishConfig(root, 'production')).rejects.toThrow(/GitHub App configuration/u)
    await writeFile(config.credentialsFile, JSON.stringify({ secretId: 'fixture', secretKey: 'fixture-only' }))
    await expect(readDesktopUploadCredentials(selected)).resolves.toEqual({ secretId: 'fixture', secretKey: 'fixture-only' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not include malformed credential contents in errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publish-config-'))
  try {
    const credentialsFile = join(root, 'credentials.json')
    await writeFile(credentialsFile, '{secret-value-should-not-appear')
    await expect(readDesktopUploadCredentials({ credentialsFile, bucket: 'test-1', origin: 'https://example.com' }))
      .rejects.not.toThrow(/secret-value/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects multiline App outputs before writing Actions output fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publish-config-'))
  try {
    await mkdir(join(root, 'publishing'))
    const config = { bucket: 'test-1', origin: 'https://download.deepseek.com', credentialsFile: join(root, 'absent.json'),
      githubApp: { clientId: 'app-id', privateKeyFile: join(root, 'key.pem') } }
    for (const githubApp of [
      { ...config.githubApp, clientId: 'app-id\nother=value' },
      { ...config.githubApp, privateKeyFile: join(root, 'key\nother=value') },
    ]) {
      await writeFile(join(root, 'publishing/production.json'), JSON.stringify({ ...config, githubApp }))
      await expect(readDesktopPublishConfig(root, 'production')).rejects.toThrow(/single-line/u)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
