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

  it('repeats a read that an older gh rejects for the escape option without that option, and no other failure', async () => {
    const calls: (readonly string[])[] = []
    const answers: (string | ForgeFailure)[] = [
      { code: 'unavailable', message: 'unknown flag: --allow-escape-sequences' }, 'diff --git a/x b/x\n',
      { code: 'unavailable', message: 'Server Error' },
    ]
    const read = async (args: readonly string[]) => { calls.push(args); return answers.shift()! }

    await expect(readComparison(read, demo, base, head, signal)).resolves.toBe('diff --git a/x b/x\n')
    expect(calls[1]).toEqual(['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github.diff', `repos/octo/demo/compare/${base}...${head}`])
    await expect(readComparison(read, demo, base, head, signal)).resolves.toEqual({ code: 'unavailable', message: 'Server Error' })
    expect(calls).toHaveLength(3)
  })

  it.each([['base', 'main', head], ['head', base, 'HEAD']])('refuses a %s that is not a full commit object name before reading', async (_label, from, to) => {
    const calls: (readonly string[])[] = []
    await expect(readComparison(async (args) => { calls.push(args); return '' }, demo, from, to, signal))
      .rejects.toThrow(`forge-github: invalid commit ${JSON.stringify(from === base ? to : from)}`)
    expect(calls).toEqual([])
  })
})
