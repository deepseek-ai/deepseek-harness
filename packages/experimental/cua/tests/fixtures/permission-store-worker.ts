/** External file writer used to verify that an open provider reloads durable authorization. */
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { PermissionState } from '../../src/permission-store.ts'
import type { CuaApplicationId } from '../../src/application-types.ts'

const [file, id] = process.argv.slice(2)
if (!file || !id) throw new Error('Expected storage file and application id')
const record = JSON.parse(await readFile(file, 'utf8')) as { global: PermissionState }
const existing = record.global.applications[id]
record.global.applications[id] = {
  revoked: (existing?.revoked ?? 0) + 1,
  sessions: {},
  always: { id: id as CuaApplicationId, name: 'Other process', executablePath: '/other' },
}
const temporary = `${file}.writer-${process.pid}`
await writeFile(temporary, JSON.stringify(record))
await rename(temporary, file)
process.stdout.write('saved\n')
