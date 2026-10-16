/** Scripted human consent for the native application replay. */
import { join } from 'node:path'
import { startFixtureHost } from './fixture-host.mjs'
export const name = 'cua-consent-fixture'
export const inject = ['userQuestions']

/** Answer through the existing human-question service while native dispatch stays real. */
export async function apply(ctx) {
  const close = await startFixtureHost(join(process.cwd(), 'native-helper.mjs'))
  ctx.effect(() => close)
  ctx.on('user-questions/request', async request => ({ answers: request.questions.map(question => ({
    id: question.id, selected: ['Allow for this task'],
  })) }))
}
