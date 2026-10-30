/** Built Desktop Host startup with incomplete or unusable Office resources; run after the repository build. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { desktopOfficeEnvironment } from '../src/office-cli.ts'
import { builtHost, prepareDesktopHome, repository } from './harness.ts'

afterEach(() => { vi.unstubAllEnvs() })

const SKILL_PROBE = 'desktop-office-skill-probe'
const OFFICE_SKILLS = ['office', 'office-docx', 'office-export-pdf', 'office-pptx', 'office-recalculate', 'office-render', 'office-xlsx']

/** Add a test-only profile bundle whose route reports the Host registry's Office skills through the real Loader. */
function installSkillProbe(root: string, profile: string): void {
  const plugin = join(profile, 'node_modules', SKILL_PROBE)
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: SKILL_PROBE, version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './bundle.yml' } },
  }))
  writeFileSync(join(plugin, 'index.js'), `
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/${SKILL_PROBE}', async handler(_request, response) {
    try {
      const names = (await ctx.skills.list()).map(skill => skill.name).filter(name => name.startsWith('office'))
      const content = {}
      for (const name of ['office-docx', 'office-export-pdf']) content[name] = (await ctx.skills.get(name))?.content ?? null
      response.end(JSON.stringify({ names, content }))
    } catch (error) {
      response.statusCode = 500
      response.end(String(error?.stack ?? error))
    }
  } }))
}
`)
  writeFileSync(join(plugin, 'bundle.yml'), `- insert:\n    - id: ${SKILL_PROBE}\n      name: ${SKILL_PROBE}\n      inject: [webServer, skills]\n`)
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  manifest.dependencies = { ...manifest.dependencies, [SKILL_PROBE]: `file:${join(root, SKILL_PROBE)}` }
  manifest.dsh.profile.bundles.push(SKILL_PROBE)
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
}

describe.skipIf(!existsSync(builtHost))('built Desktop Host Office resources', () => {
  it.each([
    ['one missing Office skill file', 'missing-skill'],
    ['an empty runtime directory', 'empty-runtime'],
    ['an unusable primary runtime path', 'relative-source'],
    ['no locatable LibreOffice Kit', 'missing-kit'],
  ] as const)('starts the Host with %s', async (_label, mode) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-office-'))
    let host: DesktopHostProcess | undefined
    const failures: Error[] = []
    try {
      const { project, paths } = await prepareDesktopHome(root)
      const runtime = join(root, 'runtime')
      mkdirSync(runtime)
      if (mode !== 'empty-runtime') {
        cpSync(join(repository, 'packages/skill/skill-office/assets'), join(runtime, 'office-skills'), { recursive: true })
        if (mode === 'missing-skill') rmSync(join(runtime, 'office-skills', 'office-docx', 'SKILL.md'))
      }
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
      if (mode === 'missing-kit') installSkillProbe(root, paths.profile)
      const primaryRuntime = mode === 'relative-source' ? 'runtime/primary-runtime' : join(runtime, 'primary-runtime')
      // An ASAR runtime path without its unpacked sibling locates no Kit; the Host itself still runs from the project.
      writeFileSync(join(root, 'app.asar'), 'archive fixture')
      const office = desktopOfficeEnvironment(mode === 'missing-kit' ? join(root, 'app.asar', 'dsh') : project, primaryRuntime)
      expect(office.kind).toBe(mode === 'missing-kit' ? 'kit-unavailable' : 'ready')
      const inherited: NodeJS.ProcessEnv = { ...process.env, DSH_BUNDLED_OFFICE_CLI: join(root, 'stale-cli.js') }
      host = new DesktopHostProcess(process.execPath, project, paths.profile, undefined,
        { ...inherited, ...office.environment }, (error) => { failures.push(error) })
      const { url } = await host.start()
      // The authenticated URL exchanges its token for a session cookie by redirecting.
      const response = await fetch(url, { redirect: 'manual' })
      await response.body?.cancel()
      expect(response.status).toBe(303)
      if (mode === 'missing-kit') {
        const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
        const probe = await fetch(new URL(`/${SKILL_PROBE}`, url), { headers: { cookie } })
        const body = await probe.text()
        expect(probe.status, body).toBe(200)
        const skills = JSON.parse(body) as { names: string[]; content: Record<string, string | null> }
        expect(skills.names.toSorted()).toEqual(OFFICE_SKILLS)
        expect(skills.content['office-docx']).toEqual(expect.any(String))
        expect(skills.content['office-docx']).not.toContain('LibreOffice Kit is disabled')
        expect(skills.content['office-export-pdf']).toMatch(/\n\nLibreOffice Kit is disabled in this deployment\.$/u)
        expect(skills.content['office-export-pdf']).not.toContain('libreofficeKit')
      }
      expect(failures).toEqual([])
    } finally {
      await host?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
