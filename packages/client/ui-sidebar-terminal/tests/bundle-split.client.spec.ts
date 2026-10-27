import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const entryPath = join(packageRoot, 'lib/client.js')
const terminalPath = join(packageRoot, 'lib/client.terminal.js')
const syncChunkCall = /(?<![\w$.])[$A-Z_a-z][\w$]*\s*\(\s*(["'`])\.\/client[^"'`/]*\.js\1\s*\)/u

describe('terminal client artifacts', () => {
  it.skipIf(!existsSync(entryPath))('keeps xterm outside the startup bundle', () => {
    expect(existsSync(terminalPath)).toBe(true)
    const entry = readFileSync(entryPath, 'utf8')
    const terminal = readFileSync(terminalPath, 'utf8')
    expect([...entry.matchAll(/\.async\s*\(\s*(["'`])(\.\/client[^"'`/]*\.js)\1\s*\)/gu)].map(match => match[2]))
      .toEqual(['./client.terminal.js'])
    expect(entry).not.toMatch(syncChunkCall)
    expect(terminal).not.toMatch(syncChunkCall)
    const entryMap = JSON.parse(readFileSync(`${entryPath}.map`, 'utf8')) as { sources: string[] }
    const terminalMap = JSON.parse(readFileSync(`${terminalPath}.map`, 'utf8')) as { sources: string[] }
    expect(entryMap.sources.some(source => source.includes('/@xterm/xterm/'))).toBe(false)
    expect(terminalMap.sources.some(source => source.includes('/@xterm/xterm/'))).toBe(true)
  })
})
