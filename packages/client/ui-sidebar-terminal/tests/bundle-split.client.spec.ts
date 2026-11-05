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
    expect([...entry.matchAll(/require\.async\((["'`])(\.\/client[^"'`/]*\.js)\1\)/gu)].map(match => match[2]))
      .toEqual(['./client.terminal.js'])
    expect(entry).not.toMatch(/\brequire\((["'`])\.\/client[^"'`/]*\.js\1\)/u)
    expect([...terminal.matchAll(/require\((["'`])(\.\/client[^"'`/]*\.js)\1\)/gu)].map(match => match[2]))
      .toEqual([])
    // Minification drops the module-path comments, so the maps name the bundled inputs.
    const sources = (path: string): string[] => (JSON.parse(readFileSync(`${path}.map`, 'utf8')) as { sources: string[] }).sources
    expect(sources(entryPath).some(source => source.includes('/@xterm+xterm@'))).toBe(false)
    expect(sources(terminalPath).some(source => source.includes('/@xterm+xterm@'))).toBe(true)
  })
})
