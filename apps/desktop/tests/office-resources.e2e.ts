/** Built Desktop Host startup with incomplete or unusable Office resources; run after the repository build. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
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
      response.end(JSON.stringify({ names, content, officeKit: ctx.get('officeKit') !== undefined, tools: ctx.tools.schemas().map(tool => tool.name).filter(name => name === 'office') }))
    } catch (error) {
      response.statusCode = 500
      response.end(String(error?.stack ?? error))
    }
  } }))
}
`)
  writeFileSync(join(plugin, 'bundle.yml'), `- insert:\n    - id: ${SKILL_PROBE}\n      name: ${SKILL_PROBE}\n      inject: [webServer, skills, tools]\n`)
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
    ['complete Office resources', 'complete'],
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
      installSkillProbe(root, paths.profile)
      const primaryRuntime = mode === 'relative-source' ? 'runtime/primary-runtime' : join(runtime, 'primary-runtime')
      host = new DesktopHostProcess(process.execPath, project, paths.profile, undefined,
        { ...process.env, DSH_BUNDLED_PRIMARY_RUNTIME: primaryRuntime }, (error) => { failures.push(error) })
      const { url } = await host.start()
      // The authenticated URL exchanges its token for a session cookie by redirecting.
      const response = await fetch(url, { redirect: 'manual' })
      await response.body?.cancel()
      expect(response.status).toBe(303)
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const probe = await fetch(new URL(`/${SKILL_PROBE}`, url), { headers: { cookie } })
      const body = await probe.text()
      expect(probe.status, body).toBe(200)
      const skills = JSON.parse(body) as { names: string[]; content: Record<string, string | null>; officeKit: boolean; tools: string[] }
      expect(skills.officeKit).toBe(true)
      // Agent presets, not the Host root, mount the office tool.
      expect(skills.tools).toEqual([])
      switch (mode) {
        case 'complete':
          expect(skills.names.toSorted()).toEqual(OFFICE_SKILLS)
          expect(skills.content['office-docx']).toEqual(expect.any(String))
          expect(skills.content['office-export-pdf']).toContain('`office` tool')
          break
        case 'missing-skill':
          expect(skills.names.toSorted()).toEqual(OFFICE_SKILLS.filter(name => name !== 'office-docx'))
          expect(skills.content['office-docx']).toBeNull()
          expect(skills.content['office-export-pdf']).toContain('`office` tool')
          break
        case 'empty-runtime':
        case 'relative-source':
          expect(skills).toMatchObject({ names: [], content: { 'office-docx': null, 'office-export-pdf': null } })
          break
      }
      expect(failures).toEqual([])
    } finally {
      await host?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
