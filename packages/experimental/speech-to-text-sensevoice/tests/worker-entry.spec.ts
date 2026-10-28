/**
 * The private worker entry run as the Host launches source workers: plain Node with the tsx ESM hook and
 * the repository paths map. Failures before readiness must leave stdout empty, because the Host parses its
 * first line as readiness, and must exit 1 with only the failure message on stderr, because the Host shows
 * that text in the preparation error.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const ENTRY = fileURLToPath(new URL('../src/worker.ts', import.meta.url))
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const TOKEN = 'a'.repeat(64)

interface Exit {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Launch the entry and collect its complete output; the child is always awaited to exit. */
async function launch(argument: string | undefined, token: string | undefined): Promise<Exit> {
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG }
  delete env.DSH_SPEECH_TOKEN
  if (token !== undefined) env.DSH_SPEECH_TOKEN = token
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), ENTRY, ...argument === undefined ? [] : [argument]], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout, stderr }
}

const LAUNCH = { dataRoot: '/nonexistent/dsh-speech', model: 'model.onnx', tokens: 'tokens.txt', vad: 'vad.onnx' }

it.each([
  ['a missing launch argument', undefined, TOKEN, 'invalid_type'],
  ['a malformed launch argument', '{', TOKEN, 'JSON'],
  ['launch JSON without model paths', JSON.stringify({ dataRoot: LAUNCH.dataRoot }), TOKEN, '"model"'],
  ['launch JSON without a data root', JSON.stringify({ ...LAUNCH, dataRoot: undefined }), TOKEN, 'dataRoot'],
  ['a missing bearer token', JSON.stringify(LAUNCH), undefined, 'invalid_type'],
  ['a malformed bearer token', JSON.stringify(LAUNCH), 'not-hex', '[a-f0-9]{64}'],
])('exits 1 before readiness on %s, reporting only the failure message', async (_case, argument, token, reason) => {
  const exit = await launch(argument, token)
  expect(exit.code).toBe(1)
  expect(exit.stdout).toBe('')
  expect(exit.stderr).toContain(reason)
  expect(exit.stderr.endsWith('\n')).toBe(true)
  expect(exit.stderr).not.toMatch(/^\s+at /mu)
  expect(exit.stderr).not.toContain('Node.js v')
}, 30_000)
