/** Parser fault checks; real-file equivalence is measured separately. */
import { it as test } from 'vitest'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSignatureRows, inspectSignaturesBatched } from '../scripts/windows-signature-batch.mjs'
import { inspectWindowsRuntimeSignature, signWindowsCode, verifyWindowsCode } from '../scripts/windows-runtime-signature.mjs'

const files = ['one.node', 'two.dll']
const rows = files.map(path => ({ path, status: 'Valid', timestamped: true, thumbprint: 'A'.repeat(40) }))
const output = (input: readonly unknown[]): string => input.map(value => JSON.stringify(value)).join('\n')

test('each row retains its own signature status', () => {
  const input = [rows[0], { ...rows[1], status: 'NotSigned', timestamped: false, thumbprint: null }]
  const result = parseSignatureRows(output(input), '', files)
  assert.deepEqual(result.map(signature => signature.status), ['Valid', 'NotSigned'])
})

for (const [name, input] of [
  ['missing', [rows[0]]], ['duplicate', [rows[0], rows[0]]], ['reordered', [...rows].reverse()],
  ['extra', [...rows, rows[0]]], ['null', [rows[0], null]],
  ['bad timestamp', [rows[0], { ...rows[1], timestamped: 'true' }]],
  ['bad certificate', [rows[0], { ...rows[1], thumbprint: 'wrong' }]],
] as const) test(`${name} output is rejected`, () => {
  assert.throws(() => parseSignatureRows(output(input), '', files))
})

test('stderr rejects otherwise complete output', () => {
  assert.throws(() => parseSignatureRows(output(rows), 'warning', files))
})
test('empty input launches no verifier and returns no rows', async () => {
  assert.deepEqual(await inspectSignaturesBatched([]), [])
})

test.skipIf(process.platform !== 'win32')('Unicode paths retain the same Windows trust result as individual inspection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'signature-batch-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "验证 ' 文件.exe")
  await copyFile(join(process.env.SystemRoot!, 'System32', 'cmd.exe'), path)
  const expected = await inspectWindowsRuntimeSignature(path)
  assert.equal(expected.status, 'Valid')
  assert.deepEqual(await inspectSignaturesBatched([path]), [expected])
  await signWindowsCode(root, {
    thumbprint: 'A'.repeat(40),
    sign: async () => { throw new Error('vendor-signed files must not access signing hardware') },
    record: () => {},
  })
  await verifyWindowsCode(root)
})
