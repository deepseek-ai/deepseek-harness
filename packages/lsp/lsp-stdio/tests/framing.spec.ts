import { describe, expect, it } from 'vitest'
import { encodeMessage, MessageDecoder } from '../src/framing.ts'

/** Frame a message the way a server would, for decoder round-trips. */
function frame(body: string): Buffer {
  return Buffer.concat([Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`, 'ascii'), Buffer.from(body, 'utf8')])
}

describe('encodeMessage', () => {
  it('prefixes a Content-Length header with the utf-8 byte length', () => {
    const buffer = encodeMessage({ jsonrpc: '2.0', method: 'x', params: { s: 'é' } })
    const text = buffer.toString('utf8')
    const body = '{"jsonrpc":"2.0","method":"x","params":{"s":"é"}}'
    expect(text).toBe(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  })
})

describe('MessageDecoder', () => {
  it('decodes a single framed message', () => {
    const decoder = new MessageDecoder(1_000)
    expect(decoder.push(frame('{"id":1,"result":42}'))).toEqual([{ id: 1, result: 42 }])
  })

  it('decodes multiple messages arriving in one chunk', () => {
    const decoder = new MessageDecoder(1_000)
    const chunk = Buffer.concat([frame('{"a":1}'), frame('{"b":2}')])
    expect(decoder.push(chunk)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('reassembles a message split across chunks', () => {
    const decoder = new MessageDecoder(1_000)
    const full = frame('{"hello":"world"}')
    expect(decoder.push(full.subarray(0, 10))).toEqual([])
    expect(decoder.push(full.subarray(10))).toEqual([{ hello: 'world' }])
  })

  it('handles a header split from its body', () => {
    const decoder = new MessageDecoder(1_000)
    const body = '{"x":1}'
    expect(decoder.push(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'))).toEqual([])
    expect(decoder.push(Buffer.from(body, 'utf8'))).toEqual([{ x: 1 }])
  })

  it('reads a case-insensitive header and ignores other headers', () => {
    const decoder = new MessageDecoder(1_000)
    const body = '{"ok":true}'
    const chunk = Buffer.from(`content-length: ${body.length}\r\nContent-Type: x\r\n\r\n${body}`, 'utf8')
    expect(decoder.push(chunk)).toEqual([{ ok: true }])
  })

  it('rejects a body over the size limit', () => {
    const decoder = new MessageDecoder(4)
    expect(() => decoder.push(frame('{"big":true}'))).toThrow(expect.objectContaining({ name: 'LspError', code: 'LSP_MESSAGE_TOO_LARGE', message: expect.stringMatching(/exceeds the 4-byte limit/) as string }))
  })

  it('rejects a missing Content-Length header', () => {
    const decoder = new MessageDecoder(1_000)
    expect(() => decoder.push(Buffer.from('X: 1\r\n\r\n{}', 'utf8'))).toThrow(expect.objectContaining({ name: 'LspError', code: 'LSP_PROTOCOL_ERROR', message: expect.stringMatching(/missing Content-Length/) as string }))
  })

  it('rejects a non-numeric Content-Length', () => {
    const decoder = new MessageDecoder(1_000)
    expect(() => decoder.push(Buffer.from('Content-Length: abc\r\n\r\n{}', 'utf8'))).toThrow(expect.objectContaining({ name: 'LspError', code: 'LSP_PROTOCOL_ERROR', message: expect.stringMatching(/invalid Content-Length/) as string }))
  })

  it('rejects a header block that never terminates', () => {
    const decoder = new MessageDecoder(1_000)
    const huge = Buffer.alloc((1 << 16) + 1, 0x41)
    expect(() => decoder.push(huge)).toThrow(expect.objectContaining({ name: 'LspError', code: 'LSP_PROTOCOL_ERROR', message: expect.stringMatching(/exceeded .* bytes without a terminator/) as string }))
  })

  it('rejects an oversized header block that includes its terminator', () => {
    const decoder = new MessageDecoder(1_000)
    const huge = Buffer.from(`Content-Length: 2\r\nX-Fill: ${'a'.repeat(70_000)}\r\n\r\n{}`, 'ascii')
    expect(() => decoder.push(huge)).toThrow(expect.objectContaining({ name: 'LspError', code: 'LSP_PROTOCOL_ERROR', message: expect.stringMatching(/header exceeded .* bytes/) as string }))
  })

  it('rejects a non-JSON body', () => {
    const decoder = new MessageDecoder(1_000)
    expect(() => decoder.push(frame('not json'))).toThrow(expect.objectContaining({ name: 'LspError', code: 'LSP_PROTOCOL_ERROR', message: expect.stringMatching(/not valid JSON/) as string }))
  })
})
