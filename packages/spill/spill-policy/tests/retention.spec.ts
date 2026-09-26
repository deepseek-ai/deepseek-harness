import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { retainContent, type RetainableBlock } from '../src/retention.ts'

const text = (value: string): RetainableBlock => ({ type: 'text', text: value })
const image = (name: string): RetainableBlock => ({
  type: 'image', attachment: {
    attachmentId: AttachmentId(`sha256:${name.repeat(64)}`), mediaType: 'image/png',
    width: 1, height: 1, bytes: 1,
  },
})
const price = (block: RetainableBlock): number => block.type === 'text' ? block.text.length : 2

describe('ordered mixed-content retention', () => {
  it('keeps both images in their original positions around a truncated middle text', () => {
    const first = image('a')
    const last = image('b')
    const result = retainContent([text('AA'), first, text('B1B2B3B4B5'), last, text('CC')], 12, price)
    expect(result).toEqual({
      head: [text('AA'), first, text('B1')], tail: [text('B5'), last, text('CC')],
      omittedBytes: 6, omittedImages: 0,
    })
  })

  it('omits a middle image together with the surrounding middle text', () => {
    const result = retainContent([text('A'.repeat(20)), image('a'), text('C'.repeat(20))], 10, price)
    expect(result).toEqual({
      head: [text('AAAAA')], tail: [text('CCCCC')], omittedBytes: 30, omittedImages: 1,
    })
  })

  it('does not cross an image that cannot fit wholly at a retained boundary', () => {
    const result = retainContent([text('A'), image('a'), text('B')], 6,
      block => block.type === 'image' ? 5 : price(block))
    expect(result).toEqual({ head: [text('A')], tail: [text('B')], omittedBytes: 0, omittedImages: 1 })
  })

  it('never duplicates overlapping head and tail content', () => {
    const result = retainContent([text('AB'), image('a'), text('CD')], 100, price)
    expect([...result.head, ...result.tail]).toEqual([text('AB'), image('a'), text('CD')])
    expect(result.omittedBytes).toBe(0)
    expect(result.omittedImages).toBe(0)
  })

  it('omits everything when the notices consume the budget', () => {
    expect(retainContent([text('雪'), image('a')], 0, price)).toEqual({
      head: [], tail: [], omittedBytes: 3, omittedImages: 1,
    })
  })

  it('omits a text suffix when its minimum framing cost exceeds the remaining budget', () => {
    const result = retainContent([text('ABC')], 4,
      block => block.type === 'text' ? block.text.length + 4 : price(block))
    expect(result).toEqual({ head: [], tail: [], omittedBytes: 3, omittedImages: 0 })
  })

  it('drops an incomplete surrogate pair at the retained prefix', () => {
    const result = retainContent([text('A😀middleZ')], 4, price)
    expect(result.head).toEqual([text('A')])
    expect(result.tail).toEqual([text('eZ')])
    expect(result.omittedBytes).toBe(Buffer.byteLength('😀middl'))
  })

  it('does not split a surrogate pair at either retained end', () => {
    const result = retainContent([text('A😀middle😀Z')], 5, price)
    expect(result.head).toEqual([text('A😀')])
    expect(result.tail).toEqual([text('Z')])
    expect(result.omittedBytes).toBe(Buffer.byteLength('middle😀'))
  })
})
