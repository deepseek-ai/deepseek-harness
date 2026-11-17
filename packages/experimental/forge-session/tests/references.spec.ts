import { describe, expect, it } from 'vitest'
import { simpleCommands } from '../src/references.ts'

const GH = /\bgh\b/

describe('simpleCommands', () => {
  it('splits a command line into simple commands with their assignments, words, and standalone first command', () => {
    expect(simpleCommands('GH_HOST=ghe.example gh pr view 5960 -R "octo/demo" 2>&1 | head -200', GH)).toEqual([
      { assignments: ['GH_HOST=ghe.example'], executable: 'gh', words: ['pr', 'view', '5960', '-R', 'octo/demo'], standalone: true },
      { assignments: [], executable: 'head', words: ['-200'], standalone: false },
    ])
    expect(simpleCommands("env 'GH_CONFIG_DIR=/tmp/gh config' gh pr view 12", GH)).toEqual([
      { assignments: ['GH_CONFIG_DIR=/tmp/gh config'], executable: 'gh', words: ['pr', 'view', '12'], standalone: true },
    ])
  })

  it('marks no command standalone when the line runs another command than an output filter', () => {
    for (const command of ['cd repo && gh pr view 1', 'gh pr view 1; ls', 'gh pr view 1 || true', 'gh pr view 1 &', 'gh pr view 1 | custom', 'gh pr view 1 | (cat)']) {
      expect(simpleCommands(command, GH).every(simple => !simple.standalone)).toBe(true)
    }
    expect(simpleCommands('gh pr view 1 |& tail -1', GH).map(simple => simple.standalone)).toEqual([true, false])
  })

  it('leaves out a simple command with another operator and a word list without an executable', () => {
    expect(simpleCommands('gh pr view 1 > out.txt && gh pr view 2', GH)).toEqual([
      { assignments: [], executable: 'gh', words: ['pr', 'view', '2'], standalone: false },
    ])
    expect(simpleCommands('env A=1 && gh pr view 2', GH).map(simple => simple.executable)).toEqual(['gh'])
  })

  it.each([
    'ls -la',
    'gh pr view $PR',
    'gh pr view $(cat number)',
    'gh pr view `cat number`',
    'gh pr view "5960',
    'gh pr view 5960\n--repo octo/demo',
  ])('yields nothing for %j', (command) => {
    expect(simpleCommands(command, GH)).toEqual([])
  })
})
