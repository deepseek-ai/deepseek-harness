/** Which parts of reply Markdown are read aloud. */
import { expect, it } from 'vitest'
import { speechText } from '../src/speech-text.ts'

it('turns headings, paragraphs, quotes and list items into one line each', () => {
  expect(speechText('# 标题\n\n第一段。\n\n> 引用的话\n\n- 甲\n- 乙\n\n1. 丙\n')).toBe('标题\n第一段。\n引用的话\n甲\n乙\n丙')
})

it('keeps the text of emphasis, links and inline code and drops markup the parser left unpaired', () => {
  expect(speechText('运行 `pnpm test`，见 [文档](https://example.com)，这很 **重要**、*强调*、~~删除~~。')).toBe('运行 pnpm test，见 文档，这很 重要、强调、删除。')
  expect(speechText('未闭合的 **标记 和 __init__ 以及 ~~波浪')).toBe('未闭合的 标记 和 init 以及 波浪')
  expect(speechText('参见 [引用][ref]。\n\n[ref]: https://example.com')).toBe('参见 引用。')
})

it('leaves out code blocks, tables, images, HTML, rules, block formulas and footnotes', () => {
  const markdown = [
    '开头。', '```sh\nrm -rf build\n```', '| 列 | 值 |\n| --- | --- |\n| a | 1 |', '![图](a.png)', '<details>隐藏</details>', '---',
    '$$\nE = mc^2\n$$', '结尾[^1]。', '[^1]: 脚注内容',
  ].join('\n\n')
  expect(speechText(markdown)).toBe('开头。\n结尾。')
  expect(speechText('```ts\nconst a = 1\n```')).toBe('')
})

it('reads a short inline formula as written and skips a long one', () => {
  expect(speechText('质能方程 $E = mc^2$ 很短。')).toBe('质能方程 E = mc^2 很短。')
  expect(speechText('这个 $\\int_0^1 x^2 \\, dx = \\frac{1}{3}$ 很长。')).toBe('这个  很长。')
  // Punctuation inside a kept formula is no markup: the underscores and asterisks are read, not paired.
  expect(speechText('下标 $a_1 * b_2 * c_3$ 照读。')).toBe('下标 a_1 * b_2 * c_3 照读。')
  expect(speechText('行内 $$E = mc^2$$ 也按块级公式略过。')).toBe('行内  也按块级公式略过。')
})

it('reads a dollar as a formula delimiter only outside code and HTML, and only in pairs', () => {
  expect(speechText('运行 `echo $HOME $PATH` 即可。')).toBe('运行 echo $HOME $PATH 即可。')
  expect(speechText('```sh\necho $A $B\n```\n\n价格是 \\$5 和 \\$10。')).toBe('价格是 $5 和 $10。')
  expect(speechText('只有一个 $ 符号。\n\n下一段还有一个 $ 符号。')).toBe('只有一个 $ 符号。\n下一段还有一个 $ 符号。')
  expect(speechText('<kbd>$x$</kbd> 之后 $y$ 照读。')).toBe('x 之后 y 照读。')
  expect(speechText('<div>\n$x$\n</div>\n\n之后 $y$ 照读。')).toBe('之后 y 照读。')
})

it('keeps amounts of money as text and still finds a formula beside them', () => {
  const plans = 'Plan A costs $20 per month while plan B costs $35.'
  expect(speechText(plans)).toBe(plans)
  expect(speechText('套餐 A 每月 $20，套餐 B 每月 $35。')).toBe('套餐 A 每月 $20，套餐 B 每月 $35。')
  expect(speechText('Between $5-$10 each, or US$5 and CA$7.')).toBe('Between $5-$10 each, or US$5 and CA$7.')
  expect(speechText('It costs $5 and the formula $x$ shows it.')).toBe('It costs $5 and the formula x shows it.')
  // Dollars padded with spaces on the inside delimit no formula.
  expect(speechText('写成 $ x + y $ 时照原样读。')).toBe('写成 $ x + y $ 时照原样读。')
})

it('treats a source line break as spacing and a hard break as a new line', () => {
  expect(speechText('第一行\n第二行')).toBe('第一行 第二行')
  expect(speechText('第一行  \n第二行')).toBe('第一行\n第二行')
  expect(speechText('\n\n')).toBe('')
})
