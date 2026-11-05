import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { hooks } from './python-runtime-deploy.pnpmfile.mjs'

it('preserves exact local build approvals, denials, and unrelated configuration', () => {
  const config = {
    strictDepBuilds: true,
    allowBuilds: {
      'allowed@file:packages/allowed': true,
      'denied@file:packages/denied': false,
      'pending@file:packages/pending': 'set this to true or false',
      'absolute@file:///already/reviewed': true,
      'registry-package': false,
    },
  }
  const identity = (name: string) => `${name}@${pathToFileURL(resolve(import.meta.dirname, '..', 'packages', name)).href}`

  expect(hooks.updateConfig(config)).toEqual({
    strictDepBuilds: true,
    allowBuilds: {
      [identity('allowed')]: true,
      [identity('denied')]: false,
      [identity('pending')]: 'set this to true or false',
      'absolute@file:///already/reviewed': true,
      'registry-package': false,
    },
  })
  expect(config.allowBuilds['allowed@file:packages/allowed']).toBe(true)
})

it('leaves configuration without local build rules unchanged', () => {
  const config = { strictDepBuilds: true }
  expect(hooks.updateConfig(config)).toBe(config)
})
