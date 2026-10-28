import { StringDecoder as NativeStringDecoder } from 'node:string_decoder'
import { describe, expect, it } from 'vitest'
import { StringDecoder } from '../../src/node/builtin_modules/implemented/string_decoder.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'

// The slash import in the shim keeps these tests on the npm implementation even under Node.
it('loads the npm decoder through both worker builtin names', () => {
  expect(StringDecoder).not.toBe(NativeStringDecoder)
  const table = createNodeBuiltins()
  const bare = table.string_decoder?.()
  expect(table['node:string_decoder']?.()).toBe(bare)
  expect(bare).toMatchObject({ StringDecoder, __esModule: true, default: { StringDecoder } })
})

describe('streamed string decoding', () => {
  it('retains UTF-8 characters split across incoming chunks', () => {
    const decoder = new StringDecoder('utf8')
    expect(decoder.write(Buffer.from([0xe4, 0xbd]))).toBe('')
    expect(decoder.write(Buffer.from([0xa0, 0xf0, 0x9f]))).toBe('你')
    expect(decoder.end(Buffer.from([0x8c, 0x8a]))).toBe('🌊')
  })

  it('retains a UTF-16 surrogate pair split between code units', () => {
    const decoder = new StringDecoder('utf16le')
    expect(decoder.write(Buffer.from([0x3c, 0xd8]))).toBe('')
    expect(decoder.end(Buffer.from([0x0a, 0xdf]))).toBe('🌊')
  })

  it('flushes an incomplete final UTF-8 character as a replacement', () => {
    const decoder = new StringDecoder('utf8')
    expect(decoder.write(Buffer.from([0xe4, 0xbd]))).toBe('')
    expect(decoder.end()).toBe('�')
  })
})
