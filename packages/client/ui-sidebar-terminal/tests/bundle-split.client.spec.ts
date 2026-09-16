import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const entryPath = join(packageRoot, 'lib/client.js')
const terminalPath = join(packageRoot, 'lib/client.terminal.js')

describe('terminal client artifacts', () => {
  it.skipIf(!existsSync(entryPath))('keeps xterm outside the startup bundle', () => {
    expect(existsSync(terminalPath)).toBe(true)
    const entry = readFileSync(entryPath, 'utf8')
    const terminal = readFileSync(terminalPath, 'utf8')
    expect([...entry.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
      .toEqual(['./client.terminal.js'])
    expect(entry).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
    expect([...terminal.matchAll(/require\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
      .toEqual([])
    expect(entry).not.toContain('/@xterm+xterm@')
    expect(terminal).toContain('/@xterm+xterm@')
  })
})
