import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Built-artifact smoke for the generated job Remote codecs. This package's
 * program compiles only the `JobKindMap` merges it can see (`bash`,
 * `subagent`), while the Host registers `pwsh`, `pty-send`, and every other
 * producer kind, so the wire projection's `kind` must reach the codec as an
 * open string rather than the literal union this program observes.
 */

const artifact = join(fileURLToPath(new URL('..', import.meta.url)), 'lib/typert.host.js')

interface BuiltInvocation {
  readonly method: string
  readonly result: { create(): { safeParse(value: unknown): { success: boolean } } }
}

const row = {
  id: 'pty-send-1',
  kind: 'pty-send',
  label: 'send',
  status: 'running',
  startedAt: 1,
  output: { total: 0, earliest: 0 },
}

describe.skipIf(!existsSync(artifact))('job Remote built codecs', () => {
  it('accept a row whose kind this program never compiled, and still reject a status outside the lifecycle', async () => {
    const { TYPERT } = await import(pathToFileURL(artifact).href) as { TYPERT: { invocations: readonly BuiltInvocation[] } }
    const schemaOf = (method: string): ReturnType<BuiltInvocation['result']['create']> => {
      const invocation = TYPERT.invocations.find(candidate => candidate.method === method)
      if (invocation === undefined) throw new Error(`no generated job.${method} invocation`)
      return invocation.result.create()
    }
    expect(schemaOf('list').safeParse({ type: 'rows', jobs: [row] }).success).toBe(true)
    expect(schemaOf('follow').safeParse({ type: 'opened', job: row, from: 0 }).success).toBe(true)
    expect(schemaOf('follow').safeParse({ type: 'status', job: { ...row, status: 'paused' } }).success).toBe(false)
  })
})
