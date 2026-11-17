/** Stage the signed helper artifact selected by the credential-free npm pack job. */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { cuaHelperSourceDigest } from './build-inputs.ts'
import { stageCuaHelperPayload } from './payload.ts'

const { values } = parseArgs({ options: { from: { type: 'string' } }, allowPositionals: false })
if (!values.from) throw new Error('Usage: stage.ts --from <extracted-helper-artifact>')
const root = resolve(import.meta.dirname, '../..')
const expected = { sourceDigest: cuaHelperSourceDigest(root),
  ...(process.env.CUA_EXPECTED_BUILD_KEY === undefined ? {} : { buildKey: process.env.CUA_EXPECTED_BUILD_KEY }) }
stageCuaHelperPayload(resolve(values.from), resolve(root, 'packages/experimental/cua-macos'), expected)
console.log(`CUA helper staged for source digest ${expected.sourceDigest}`)
