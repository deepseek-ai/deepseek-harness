/** The user switch and the viewing Agent decide whether a kind's skill is listed and loadable. */
import { expect, it } from 'vitest'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session'
import Skills, { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
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

it('leaves a card skill out of a fresh subagent and keeps it in a fork, whose inherited catalog already names it', async () => {
  const f = await fixture()
  await mountCardSkill(f)
  const meta = { parentSession: f.agent.id, origin: 'subagent' } as const
  const { agent: fresh } = await f.ctx.agents.create({ sessionId: brandString<SessionId>('cards-fresh'), meta })
  const seed = f.agent.session.snapshotEvents()
  const { agent: fork } = await f.ctx.agents.create({ sessionId: brandString<SessionId>('cards-fork'), seed,
    inheritedEventCount: SessionLogOffset(seed.length), meta: { ...meta, isSeeded: true } })
  const listed = async (scope: Agent) => (await f.ctx.skills.list({ scope })).some(skill => skill.name === cardSkill.name)
  expect(await listed(f.agent)).toBe(true)
  expect(await listed(fork)).toBe(true)
  expect(await listed(fresh)).toBe(false)
  expect(await f.ctx.skills.get(cardSkill.name, { scope: fresh })).toBeUndefined()
})
