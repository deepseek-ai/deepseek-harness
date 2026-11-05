/** The loopback protocol server answers unrouted paths and fixture failures instead of leaving requests open. */

import { expect, it } from 'vitest'
import { oauthWorld } from '../src/index.ts'

it('answers an unrouted path with 404 and a failing token behavior with 500', async () => {
  const world = await oauthWorld(false)
  expect((await fetch(world.origin + '/unrouted')).status).toBe(404)
  world.behavior.token = async () => { throw new Error('fixture token failure') }
  expect((await fetch(world.origin + '/token', { method: 'POST', body: 'grant_type=refresh_token' })).status).toBe(500)
})
