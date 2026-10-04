/** The bundled skill owns its registry candidate and extracted resource directory. */

import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import { ACL_DIAGNOSIS_SKILL, registerAclDiagnosisSkill } from '../src/acl-skill.ts'

describe('bundled Windows ACL diagnosis skill', () => {
  it('registers the packaged body and removes the candidate on disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin({
        name: 'acl-skill-registration',
        inject: ['skills'],
        apply: (inner: Context) => { registerAclDiagnosisSkill(inner) },
      })

      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual([ACL_DIAGNOSIS_SKILL])
      const entry = catalog[0]!
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeLessThanOrEqual(500)
      expect(entry).toMatchObject({
        source: 'bundled',
        provider: 'dsh-windows-acl',
        invocation: { modelInvocable: true, userInvocable: true },
      })

      const loaded = await ctx.skills.get(ACL_DIAGNOSIS_SKILL)
      expect(loaded?.resourceBase).toMatchObject({ kind: 'directory' })
      if (loaded?.resourceBase?.kind !== 'directory') throw new Error('Missing physical skill resource directory')
      const resourceDirectory = loaded.resourceBase.path
      expect(readFileSync(join(resourceDirectory, 'scripts/diagnose-windows-sandbox-acl.ps1'), 'utf8'))
        .toBe(readFileSync(new URL('../assets/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1', import.meta.url), 'utf8'))
      // The body names the bundled script — the repair path the model must use
      // instead of editing ACLs by hand.
      expect(loaded?.content).toContain('scripts\\diagnose-windows-sandbox-acl.ps1')
      // Leave room for the tool wrapper below the default 8192-character prune threshold.
      expect(loaded?.content.length).toBeLessThan(7_000)

      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
      expect(existsSync(resourceDirectory)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['missing frontmatter', '# Invalid skill', 'has no YAML frontmatter'],
    ['non-object metadata', '---\nnull\n---\nBody', 'has no description'],
    ['empty description', '---\ndescription: ""\n---\nBody', 'has no description'],
  ])('rejects an extracted skill with %s', async (_name, raw, message) => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin({ name: 'acl-skill-invalid-resource', inject: ['skills'], apply: registerAclDiagnosisSkill })
      const skill = await ctx.skills.get(ACL_DIAGNOSIS_SKILL)
      if (skill?.resourceBase?.kind !== 'directory') throw new Error('Missing physical skill resource directory')
      writeFileSync(join(skill.resourceBase.path, 'SKILL.md'), raw)
      await expect(ctx.skills.get(ACL_DIAGNOSIS_SKILL)).rejects.toThrow(message)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
