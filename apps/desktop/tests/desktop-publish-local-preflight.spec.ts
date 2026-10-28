import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { preflightDesktopPublishLocal } from '../scripts/preflight-desktop-publish-local.mjs'

it('checks the retained preset before approval and the approved preset before upload without opening credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publish-preflight-'))
  try {
    const configRoot = join(root, 'packaging')
    const releases = join(root, 'custom-releases')
    const manifest = join(releases, '42', '2')
    await mkdir(manifest, { recursive: true })
    await writeFile(join(manifest, 'manifest.json'), JSON.stringify({ source: { preset: 'test' } }))
    const env = { DSH_PACKAGING_CONFIG_DIR: configRoot, DSH_DESKTOP_RELEASES_DIR: releases,
      DESKTOP_PACKAGE_SELECTION: JSON.stringify({ run: { id: 42, run_attempt: 2 } }) }
    await expect(preflightDesktopPublishLocal(env)).rejects.toThrow(`publication configuration is missing, unreadable or invalid JSON: ${join(configRoot, 'publishing', 'test.json')}`)
    await mkdir(join(configRoot, 'publishing'), { recursive: true })
    await writeFile(join(configRoot, 'publishing', 'test.json'), JSON.stringify({ credentialsFile: join(root, 'absent-secret.json') }))
    await expect(preflightDesktopPublishLocal(env)).resolves.toBeUndefined()
    const approved = { ...env, DESKTOP_PUBLISH_ROUTE: JSON.stringify({ preset: 'production' }) }
    await expect(preflightDesktopPublishLocal(approved)).rejects.toThrow('production.json')
    await writeFile(join(configRoot, 'publishing', 'production.json'), '{secret-invalid-json')
    await expect(preflightDesktopPublishLocal(approved)).rejects.toThrow('invalid JSON')
    await writeFile(join(configRoot, 'publishing', 'production.json'), '[]')
    await expect(preflightDesktopPublishLocal(approved)).rejects.toThrow('must be a JSON object')
    await writeFile(join(configRoot, 'publishing', 'production.json'), '{}')
    await expect(preflightDesktopPublishLocal(approved)).resolves.toBeUndefined()
    await expect(preflightDesktopPublishLocal({ ...approved, DESKTOP_PUBLISH_ROUTE: '{"preset":"../test"}' })).rejects.toThrow('preset must be')
    await expect(preflightDesktopPublishLocal({ ...env, DESKTOP_PACKAGE_SELECTION: '{"run":{"id":"../42","run_attempt":2}}' })).rejects.toThrow('positive run ID')
    await expect(preflightDesktopPublishLocal({ ...env, DSH_DESKTOP_RELEASES_DIR: '' })).rejects.toThrow('retained package manifest')
    await expect(preflightDesktopPublishLocal({ ...env, DSH_PACKAGING_CONFIG_DIR: 'relative' })).rejects.toThrow('absolute machine')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('runs the local preflight before dependency installation in both self-hosted jobs', async () => {
  const workflow = await readFile('.github/workflows/desktop-publish.yml', 'utf8')
  for (const job of ['prepare', 'publish']) {
    const section = workflow.split(`\n  ${job}:`)[1]!.split(/\n  \w+:/u)[0]!
    expect(section.indexOf('node apps/desktop/scripts/preflight-desktop-publish-local.mjs')).toBeGreaterThan(0)
    expect(section.indexOf('node apps/desktop/scripts/preflight-desktop-publish-local.mjs')).toBeLessThan(section.indexOf('pnpm install --frozen-lockfile'))
  }
})
