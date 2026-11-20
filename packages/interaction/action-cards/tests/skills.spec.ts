/** The user switch decides whether a kind's skill is listed and loadable. */
import { expect, it } from 'vitest'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import type { Context } from '@deepseek-ai/cordis'
import Skills, { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { Config } from '../src/index.ts'
import { fixture } from './fixture.ts'

type Fixture = Awaited<ReturnType<typeof fixture>>

const cardSkill = { name: 'card-skill', description: 'Use card-skill.', provider: 'card-skill-provider', source: 'bundled' as const,
  rank: BUNDLED_SKILL_RANK, locator: null, invocation: { modelInvocable: true, userInvocable: false } }

/** Mount the skill registry and a kind plugin that registers {@link cardSkill} through `skillProvider`. */
async function mountCardSkill(f: Fixture) {
  await f.ctx.plugin(Skills)
  return f.ctx.plugin({ name: 'card-skill-kind', inject: ['actionCards', 'skills'], apply: (inner: Context) => {
    inner.skills.registerProvider(inner.actionCards.skillProvider(cardSkill, () => Promise.resolve({ ...cardSkill, content: 'Offer the card.' })))
  } })
}

it('lists a card skill only while the user switch is on, for its registrant\'s lifetime', async () => {
  const f = await fixture()
  const registrant = await mountCardSkill(f)
  const listed = async () => (await f.ctx.skills.list()).some(skill => skill.name === cardSkill.name)
  const switchCards = (value: boolean) => {
    updateVolatile((f.cards.effectiveConfig as Config).enabled, createVolatile(value))
    f.cards.ctx.emit('loader/volatile-update', [['enabled']])
  }
  expect(await listed()).toBe(true)
  expect((await f.ctx.skills.get(cardSkill.name))?.content).toBe('Offer the card.')
  switchCards(false)
  expect(await listed()).toBe(false)
  expect(await f.ctx.skills.get(cardSkill.name)).toBeUndefined()
  switchCards(true)
  expect(await listed()).toBe(true)
  await registrant.dispose()
  expect(await listed()).toBe(false)
  switchCards(false)
  expect(await listed()).toBe(false)
})
