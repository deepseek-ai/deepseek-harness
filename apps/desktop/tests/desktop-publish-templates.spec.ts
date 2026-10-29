import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { readDesktopPublishConfig, type DesktopPublishConfig } from '../scripts/desktop-publish-config.ts'

for (const platform of ['macos', 'windows'] as const) {
  for (const preset of ['test', 'production'] as const) {
    it(`accepts the ${platform} ${preset} template after machine paths are supplied`, async () => {
      const path = fileURLToPath(new URL(`../config/publishing/${platform}/${preset}.json.example`, import.meta.url))
      const template = JSON.parse(await readFile(path, 'utf8')) as DesktopPublishConfig
      const paths = platform === 'windows' ? win32 : posix
      expect(paths.isAbsolute(template.credentialsFile)).toBe(true)
      expect(template[platform === 'macos' ? 'macOS' : 'windows']).toBeDefined()
      expect(Object.hasOwn(template, 'secretId')).toBe(false)
      expect(Object.hasOwn(template, 'secretKey')).toBe(false)
      if (preset === 'production') expect(paths.isAbsolute(template.githubApp?.privateKeyFile ?? '')).toBe(true)
      const root = await mkdtemp(join(tmpdir(), 'publish-template-'))
      try {
        await mkdir(join(root, 'publishing'))
        // The parser uses the current host's path syntax; examples retain their target platform's paths.
        const config = { ...template, credentialsFile: join(root, 'absent-credentials.json'),
          ...(template.githubApp ? { githubApp: { ...template.githubApp, privateKeyFile: join(root, 'absent-key.pem') } } : {}) }
        const output = join(root, 'publishing', `${preset}.json`)
        await writeFile(output, JSON.stringify(config))
        await expect(readDesktopPublishConfig(root, preset)).resolves.toEqual(config)
        await writeFile(output, JSON.stringify({ ...config, bucket: undefined }))
        const failure = readDesktopPublishConfig(root, preset)
        await expect(failure).rejects.toHaveProperty('name', 'ZodError')
        await expect(failure).rejects.toHaveProperty('issues.0.path', ['bucket'])
      } finally { await rm(root, { recursive: true, force: true }) }
    })
  }
}
