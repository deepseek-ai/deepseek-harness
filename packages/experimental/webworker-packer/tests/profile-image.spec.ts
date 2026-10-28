/**
 * The image carries what the Worker boots from: the profile's bundle packages,
 * the installation's optional bundles with the packages their patch rows name,
 * and the installation manifest alone as the bundle resolution anchor. No
 * composed configuration is packed; the Worker composes the bundle layers itself.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, type TestContext } from 'vitest'
import { OPTIONAL_BUNDLES, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { HOME_PATCH_PATH, MANIFEST_PATH, packVfsImage } from '../src/pack.ts'
import { installationManifest, platformHomePatch, profileRoster } from '../src/repository.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

describe('profile roster', () => {
  it('lists the template bundles, every optional bundle, and the packages their patch rows name', () => {
    const { bundles, roster } = profileRoster(repoRoot, 'web')
    expect(bundles).toEqual([...PROFILE_TEMPLATES.web!.bundles, ...OPTIONAL_BUNDLES])
    expect(roster).toEqual(expect.arrayContaining([
      ...bundles,
      // Rows inserted by the base and Web bundles.
      '@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/dsh-host-webserver',
      // Rows inserted by optional bundles, including grouped ones.
      '@deepseek-ai/dsh-session-title-all-prompts-llm', '@deepseek-ai/dsh-experimental-inspector',
      '@deepseek-ai/dsh-tool-session-query',
    ]))
    expect(new Set(roster).size).toBe(roster.length)
    expect(roster.every(name => name.startsWith('@') || !name.includes('/'))).toBe(true)
  })

  it('refuses a profile without a shipped template', () => {
    expect(() => profileRoster(repoRoot, 'no-such-profile')).toThrow(/no shipped profile template named "no-such-profile"/)
  })

  it('names the CLI manifest as the installation', () => {
    expect(installationManifest(repoRoot)).toEqual({
      name: '@deepseek-ai/dsh',
      manifest: join(repoRoot, 'apps/cli/package.json'),
    })
  })
})

describe('platform home patch', () => {
  it('keeps the composed JSONL row config and sets the plaintext compression the Worker requires', () => {
    expect(platformHomePatch(repoRoot, 'web')).toEqual([{
      id: 'session-persistence-jsonl',
      config: { root: { __jsExpr: "dshHomePath('sessions')" }, compression: 'none' },
    }])
  })
})

describe('image layout', () => {
  function subject(test: TestContext): { root: string; installation: string } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-image-installation-'))
    test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    mkdirSync(join(root, 'subject/lib'), { recursive: true })
    writeFileSync(join(root, 'subject/package.json'), JSON.stringify({ name: 'subject', files: ['lib'], exports: { '.': './lib/index.js' } }))
    writeFileSync(join(root, 'subject/lib/index.js'), 'export const value = 1')
    const installation = join(root, 'installation.json')
    writeFileSync(installation, JSON.stringify({ name: '@scope/app', dependencies: { subject: '1.0.0', absent: '1.0.0' } }))
    return { root, installation }
  }

  it('records the profile and installation and carries only the installation manifest', (test) => {
    const { root, installation } = subject(test)
    const result = packVfsImage({
      profile: 'web', roster: ['subject'], installation: { name: '@scope/app', manifest: installation },
      workspaces: new Map([['subject', join(root, 'subject')]]), resolveFrom: root, entries: [],
    })
    expect(result.missing).toEqual([])
    expect(Object.keys(result.files).filter(name => name.startsWith('node_modules/@scope/app/'))).toEqual(['node_modules/@scope/app/package.json'])
    expect(JSON.parse(new TextDecoder().decode(result.files['node_modules/@scope/app/package.json'])))
      .toEqual({ name: '@scope/app', dependencies: { subject: '1.0.0', absent: '1.0.0' } })
    // The manifest is the only configuration-directory entry: no composed profile is packed.
    expect(Object.keys(result.files).filter(name => name.startsWith('config/'))).toEqual([MANIFEST_PATH])
    expect(JSON.parse(new TextDecoder().decode(result.files[MANIFEST_PATH]))).toMatchObject({
      profile: 'web', installation: '@scope/app',
    })
  })

  it('writes the home patch the image app-boot reads, keeping expression values', (test) => {
    const { root, installation } = subject(test)
    const homePatch = [{ id: 'session-persistence-jsonl', config: { root: { __jsExpr: "dshHomePath('sessions')" }, compression: 'none' } }]
    const result = packVfsImage({
      profile: 'web', roster: ['subject'], installation: { name: '@scope/app', manifest: installation },
      workspaces: new Map([['subject', join(root, 'subject')]]), resolveFrom: root, entries: [], homePatch,
    })
    expect(HOME_PATCH_PATH).toBe('home/cordis.patch.yml')
    const text = new TextDecoder().decode(result.files[HOME_PATCH_PATH])
    expect(text).toContain("!!js dshHomePath('sessions')")
    expect(yaml.load(text, { schema: entryListSchema })).toEqual(homePatch)
  })

  it('refuses an installation that is also a roster package', (test) => {
    const { root, installation } = subject(test)
    expect(() => packVfsImage({
      profile: 'web', roster: ['subject'], installation: { name: 'subject', manifest: installation },
      workspaces: new Map([['subject', join(root, 'subject')]]), resolveFrom: root, entries: [],
    })).toThrow(/installation subject is also materialized/)
  })
})
