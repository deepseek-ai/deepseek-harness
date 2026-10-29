import type { Paragraph, Root } from 'mdast'
import { describe, expect, it } from 'vitest'
import { parseGfm, parseGfmWithMath } from '../src/markdown/parse.ts'

/** Each phrasing child as a link destination, its literal text, or its type. */
function phrasing(root: Root): unknown[] {
  return (root.children[0] as Paragraph).children.map(node =>
    node.type === 'link' ? { link: node.url } : node.type === 'text' ? node.value : node.type)
}

describe.each([parseGfm, parseGfmWithMath])('autolink literals in %o', (parse) => {
  it('end before non-ASCII punctuation', () => {
    expect(phrasing(parse('工作台还在 http://127.0.0.1:8790/。建议先彩排；如果超过 18 分钟'))).toEqual(
      ['工作台还在 ', { link: 'http://127.0.0.1:8790/' }, '。建议先彩排；如果超过 18 分钟'])
    expect(phrasing(parse('见 https://example.com，然后'))).toEqual(['见 ', { link: 'https://example.com' }, '，然后'])
    expect(phrasing(parse('（https://example.com/a?b=1）'))).toEqual(['（', { link: 'https://example.com/a?b=1' }, '）'])
    expect(phrasing(parse('见 www.example.com/a.。'))).toEqual(['见 ', { link: 'http://www.example.com/a' }, '.。'])
    expect(phrasing(parse('https://a.com/x、https://b.com/y。'))).toEqual(
      [{ link: 'https://a.com/x' }, '、', { link: 'https://b.com/y' }, '。'])
    expect(phrasing(parse('（www.example.com/a）后'))).toEqual(['（', { link: 'http://www.example.com/a' }, '）后'])
    expect(phrasing(parse('😀参见（https://example.com/a_(b)），再看'))).toEqual(
      ['😀参见（', { link: 'https://example.com/a_(b)' }, '），再看'])
    const qq = 'https://qm.qq.com/cgi-bin/qm/qr?k=Abc%2BDef%2Fghi%3D%3D&authKey=tok%252Fvalue%253D&noverify=0'
    expect(phrasing(parse(`加入群聊：${qq}，欢迎。`))).toEqual(['加入群聊：', { link: qq }, '，欢迎。'])
    // After an unbalanced `[`, the literal comes from the text transform instead of the tokenizer.
    // Its case-insensitive Unicode regex must keep ASCII `s` and `k`, which fold with `ſ` and `K`.
    expect(phrasing(parse('[x https://example.com/docs/Kit?s=K。后'))).toEqual(
      ['[x ', { link: 'https://example.com/docs/Kit?s=K' }, '。后'])
    for (const prefix of ['', '[x ']) {
      expect(phrasing(parse(`${prefix}https://example.com/a😀下一句`))).toEqual(
        [prefix, { link: 'https://example.com/a' }, '😀下一句'].filter(part => part !== ''))
      expect(phrasing(parse(`${prefix}https://example.com/a\u3000下一句`))).toEqual(
        [prefix, { link: 'https://example.com/a' }, '\u3000下一句'].filter(part => part !== ''))
      expect(phrasing(parse(`${prefix}https://example.com/a𝒳b ok`))).toEqual(
        [prefix, { link: 'https://example.com/a𝒳b' }, ' ok'].filter(part => part !== ''))
    }
    // Unencoded non-ASCII punctuation inside a URL also ends it.
    expect(phrasing(parse('https://zh.wikipedia.org/wiki/中文（消歧义）'))).toEqual(
      [{ link: 'https://zh.wikipedia.org/wiki/中文' }, '（消歧义）'])
  })

  it('leave following inline Markdown to the inline grammar', () => {
    expect(phrasing(parse('https://example.com/a，**下一句**'))).toEqual([{ link: 'https://example.com/a' }, '，', 'strong'])
    expect((parse('预览在 **https://example.com/a**（PR #1）').children[0] as Paragraph).children).toMatchObject([
      { value: '预览在 ' },
      { type: 'strong', children: [{ type: 'link', url: 'https://example.com/a' }] },
      { value: '（PR #1）' },
    ])
  })

  it('keep letters, ASCII punctuation, and authored links', () => {
    expect(phrasing(parse('https://zh.wikipedia.org/wiki/中文_(消歧义)?q=a,b ok'))).toEqual(
      [{ link: 'https://zh.wikipedia.org/wiki/中文_(消歧义)?q=a,b' }, ' ok'])
    expect(phrasing(parse('<https://example.com/。a>'))).toEqual([{ link: 'https://example.com/。a' }])
    expect(phrasing(parse('[link](https://example.com/。a)'))).toEqual([{ link: 'https://example.com/。a' }])
  })
})
