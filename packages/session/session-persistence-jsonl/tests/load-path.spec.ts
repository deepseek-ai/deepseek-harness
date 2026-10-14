/** JSONL plugin metadata must survive the Loader's module normalization. */
import { expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

it('retains the JSONL namespace and configuration through the Loader', () => {
  expect('default' in JsonlPersistence).toBe(false)
  const loader = Object.create(Loader.prototype) as Loader
  const plugin = loader.unwrapExports(JsonlPersistence) as typeof JsonlPersistence
  expect(plugin).toBe(JsonlPersistence)
  expect(plugin.name).toBe('session-persistence-jsonl')
  expect(plugin.Config).toBeDefined()
  expect(plugin.Config).toBe(JsonlPersistence.Config)
  expect(typeof plugin.apply).toBe('function')
})
