/** Go regex matching runs in a terminable source-mode worker, not on the test runner's event loop. */
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { patchGoGrammar } from '../src/markdown/highlight.ts'
import { GO_SOURCE } from './go-source.ts'

it('highlights struct comments with braces without blocking settled or streaming code', async () => {
  // The worker and highlight.ts use erasable syntax and only package-name imports, so Node loads them directly.
  const worker = new Worker(new URL('./go-highlighting.worker.ts', import.meta.url))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const fail = (message: string): void => { reject(new Error(message)) }
      timer = setTimeout(() => { fail('Go grammar did not load within 120 seconds') }, 120_000)
      worker.on('message', (reply: unknown) => {
        if (reply !== 'loaded') {
          resolve(reply)
          return
        }
        clearTimeout(timer)
        // Bound runaway synchronous matching once imports and grammar loading are done.
        timer = setTimeout(() => { fail('Go highlighting did not complete within 10 seconds') }, 10_000)
      })
      worker.once('error', reject)
      worker.once('exit', (code) => { fail(`Go highlighting worker exited before its reply: ${code}`) })
    })
    expect(result).toMatchObject({ text: GO_SOURCE, streamingMatchesSettled: true })
    expect(result).toHaveProperty('html', expect.stringContaining('var(--shiki-'))
    const keyword = (...texts: string[]): string[] => texts.map(text => `${text}:keyword`)
    expect(result).toHaveProperty('colored', [
      ['package:keyword', 'example:function'],
      [],
      ['type:keyword', 'Record:function', 'struct:keyword'],
      ['// docs: {id} explains the ordinary field names for an example record ending here:comment'],
      ['int:keyword'],
      [],
      [],
      ['type:keyword', 'Inline:function', ...keyword('struct', 'string', 'int')],
      ['type:keyword', 'Nested:function', ...keyword('struct', 'map', 'string', 'struct', 'struct', 'int')],
      ['type:keyword', 'OneLineFields:function', ...keyword('struct', 'int', 'chan<-', 'struct', 'string'),
        'sync:function', 'Mutex:function'],
      ['type:keyword', 'SplitOneLine:function', ...keyword('struct', 'int'), 'B:function', 'string:keyword'],
      [],
      [...keyword('var', '=', 'struct', 'string'), 'Port:function', 'int:keyword', 'Tags:function', 'string:keyword'],
      [],
      ['type:keyword', 'Many:function', ...keyword('struct', ...Array<string>(24).fill('int'), 'struct', 'int')],
      ['type:keyword', 'Open:function', 'struct:keyword', ...Array<string>(47).fill('field:function')],
    ])
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}, 150_000)

it('patches exactly the vendored struct-field rule and rejects a grammar without it', async () => {
  const { default: grammars } = await import('@shikijs/langs/go')
  const other = { name: 'go-embedded', scopeName: 'source.go.embedded', patterns: [], repository: {} }
  const before = grammars[0]?.repository.struct_variables_types_fields?.patterns
  const patched = patchGoGrammar([...grammars, other])
  const after = patched[0]?.repository.struct_variables_types_fields?.patterns
  const changed = after?.flatMap((rule, index) => rule === before?.[index] ? [] : [[before?.[index]?.match, rule.match]])
  expect(changed).toEqual([[
    expect.stringContaining('[^"/`\\s]+;?'),
    '(?:(?<=\\{)([^/\\`"]*[^\\s/\\`"])\\s*(?=\\}))',
  ]])
  expect(patched[1]).toBe(other)
  for (const repository of [{}, { struct_variables_types_fields: {} }]) {
    expect(() => patchGoGrammar([{ name: 'go', scopeName: 'source.go', patterns: [], repository }]))
      .toThrow('expected exactly one Go struct-field rule to patch for worlpaker/go-syntax#25, found 0')
  }
  expect(() => patchGoGrammar([other])).toThrow('found 0')
})
