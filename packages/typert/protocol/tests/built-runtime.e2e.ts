import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it.each(['../lib/index.js', '../lib/types/remote-info.js'])(
  'keeps the published protocol entry %s free of Zod runtime imports',
  async (entry) => {
    const source = await readFile(new URL(entry, import.meta.url), 'utf8')
    expect(source).not.toMatch(/\b(?:from|import|require)\s*(?:\(\s*)?['"]zod(?:\/[^'"]*)?['"]/)
  },
)
