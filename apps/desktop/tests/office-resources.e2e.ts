/** Built Desktop Host startup with incomplete or unusable Office resources; run after the repository build. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertOfficeSkillsLoadable } from '../scripts/smoke-runtime.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { builtHost, prepareDesktopHome } from './harness.ts'

afterEach(() => { vi.unstubAllEnvs() })

const SKILL_PROBE = 'desktop-office-skill-probe'
const OFFICE_SKILLS = ['office', 'office-docx', 'office-pptx', 'office-xlsx']

/** Add a test-only profile bundle whose route reports the Host registry's Office skills through the real Loader. */
function installSkillProbe(profile: string): void {
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
      const listed = new Set(names)
      const loaded = await Promise.all(${JSON.stringify(OFFICE_SKILLS)}.map(async name => {
        const skill = listed.has(name) ? await ctx.skills.get(name) : undefined
        return { name, bytes: skill?.content.length ?? 0 }
      }))
      const content = {}
      for (const name of ['office', 'office-docx']) content[name] = (await ctx.skills.get(name))?.content ?? null
      response.end(JSON.stringify({ names, content, loaded, officeKit: ctx.get('officeKit') !== undefined, tools: ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('office_')) }))
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
  manifest.dependencies = { ...manifest.dependencies, [SKILL_PROBE]: `file:${plugin}` }
  manifest.dsh.profile.bundles.push(SKILL_PROBE)
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
}

describe.skipIf(!existsSync(builtHost))('built Desktop Host Office resources', () => {
  it.each([
    ['an empty runtime directory', 'empty-runtime'],
    ['an unusable primary runtime path', 'relative-source'],
  ] as const)('starts the Host with %s and the packaged Office skills', async (_label, mode) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-office-'))
    let host: DesktopHostProcess | undefined
    const failures: Error[] = []
    try {
      const { project, paths } = await prepareDesktopHome(root)
      const runtime = join(root, 'runtime')
      mkdirSync(runtime)
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
      installSkillProbe(paths.profile)
      const primaryRuntime = mode === 'relative-source' ? 'runtime/primary-runtime' : join(runtime, 'primary-runtime')
      host = new DesktopHostProcess(process.execPath, project, paths.profile, undefined,
        process.env, (error) => { failures.push(error) }, primaryRuntime)
      const { url, authenticationCookie: cookie } = await host.start()
      const response = await fetch(url, { headers: { cookie }, redirect: 'manual' })
      await response.body?.cancel()
      expect(response.status).toBe(200)
      const probe = await fetch(new URL(`/${SKILL_PROBE}`, url), { headers: { cookie } })
      const body = await probe.text()
      expect(probe.status, body).toBe(200)
      const skills = JSON.parse(body) as {
        names: string[]
        content: Record<string, string | null>
        loaded: { name: string; bytes: number }[]
        officeKit: boolean
        tools: string[]
      }
      assertOfficeSkillsLoadable(skills.loaded)
      expect(skills.officeKit).toBe(true)
      // Agent presets, not the Host root, mount the Office tools.
      expect(skills.tools).toEqual([])
      // skill-office reads the skills from its packaged assets, independent of the primary runtime directory.
      expect(skills.names.toSorted()).toEqual(OFFICE_SKILLS)
      expect(skills.content['office-docx']).toEqual(expect.any(String))
      expect(skills.content.office).toContain('`office_render`')
      expect(failures).toEqual([])
    } finally {
      await host?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
