/** Stage the signed helper artifact selected by the credential-free npm pack job. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { stageCuaHelperPayload } from './payload.ts'

const { values } = parseArgs({ options: { from: { type: 'string' } }, allowPositionals: false })
if (!values.from) throw new Error('Usage: stage.ts --from <extracted-helper-artifact>')
const root = resolve(import.meta.dirname, '../..')
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
stageCuaHelperPayload(resolve(values.from), resolve(root, 'packages/experimental/cua-macos'), { version, commit })
console.log(`CUA helper staged for ${version} (${commit})`)
