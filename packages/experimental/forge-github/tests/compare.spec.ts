import type { ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { readComparison } from '../src/compare.ts'
import { demo } from './fixtures.ts'

const signal = new AbortController().signal
const [base, head] = ['a'.repeat(40), 'b'.repeat(64)]

describe('compare read', () => {
  it('reads the diff media type of the three-dot comparison, keeping escape sequences, and returns what the reader returns', async () => {
    const calls: (readonly string[])[] = []
    const refused: ForgeFailure = { code: 'too-large', message: 'Not Acceptable' }
    let answer: string | ForgeFailure = 'diff --git a/x b/x\n'
    const read = async (args: readonly string[]) => { calls.push(args); return answer }

    await expect(readComparison(read, demo, base, head, signal)).resolves.toBe('diff --git a/x b/x\n')
    answer = refused
    await expect(readComparison(read, demo, base, head, signal)).resolves.toBe(refused)
    expect(calls[0]).toEqual([
      'api', '--hostname', 'github.com', '--allow-escape-sequences', '-H', 'Accept: application/vnd.github.diff', `repos/octo/demo/compare/${base}...${head}`,
    ])
  })

  it.each([['base', 'main', head], ['head', base, 'HEAD']])('refuses a %s that is not a full commit object name before reading', async (_label, from, to) => {
    const calls: (readonly string[])[] = []
    await expect(readComparison(async (args) => { calls.push(args); return '' }, demo, from, to, signal))
      .rejects.toThrow(`forge-github: invalid commit ${JSON.stringify(from === base ? to : from)}`)
    expect(calls).toEqual([])
  })
})
