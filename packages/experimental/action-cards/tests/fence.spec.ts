import { expect, it } from 'vitest'
import { actionCardFences } from '../src/fence.ts'

const card = '{"a":1}'

it('reads action-card blocks of either marker in text order, decoding and matching the language as the Chat client does', () => {
  expect(actionCardFences(`Answer.\n\n\`\`\`action-card\n${card}\n\`\`\`\n`)).toEqual([card])
  expect(actionCardFences(`x\n~~~~ Action-Card extra words\n${card}\n~~~~\nafter`)).toEqual([card])
  expect(actionCardFences(`\`\`\`action-card{"c":3}\n${card}\n\`\`\``)).toEqual([card])
  expect(actionCardFences(`\`\`\`action-card\r\n${card}\r\n\`\`\``)).toEqual([card])
  expect(actionCardFences('```action-card\n1\n```\ntext\n```action-card\n2\n```')).toEqual(['1', '2'])
  expect(actionCardFences(`text\n\`\`\`action-card\n${card}`)).toEqual([card])
  expect(actionCardFences(`\`\`\`action\\-card\n${card}\n\`\`\``)).toEqual([card])
  expect(actionCardFences(`\`\`\`&#97;ction&#x2D;card\n${card}\n\`\`\``)).toEqual([card])
})

it('reads blocks nested in lists and block quotes, as the client renders them there too', () => {
  expect(actionCardFences(`- item\n\n  \`\`\`action-card\n  ${card}\n  \`\`\``)).toEqual([card])
  expect(actionCardFences(`1. step\n   \`\`\`action-card\n   ${card}\n   \`\`\``)).toEqual([card])
  expect(actionCardFences(`- \`\`\`action-card\n  ${card}\n  \`\`\``)).toEqual([card])
  expect(actionCardFences(`> \`\`\`action-card\n> ${card}\n> \`\`\``)).toEqual([card])
})

it('skips text the client does not render as a card block: other languages, empty blocks, HTML, indented code and nested fences', () => {
  expect(actionCardFences('No card here.')).toEqual([])
  expect(actionCardFences('action-card mentioned in prose, with an unlabeled block\n\n```\n{}\n```')).toEqual([])
  expect(actionCardFences('```json\n{"action-card":true}\n```')).toEqual([])
  expect(actionCardFences('```action-cards\n{}\n```')).toEqual([])
  expect(actionCardFences('```+action-card\n{}\n```')).toEqual([])
  expect(actionCardFences('```action-card\n```')).toEqual([])
  expect(actionCardFences(`<details>\n\`\`\`action-card\n${card}\n\`\`\`\n</details>`)).toEqual([])
  expect(actionCardFences(`    \`\`\`action-card\n    ${card}\n    \`\`\``)).toEqual([])
  expect(actionCardFences(`\`\`\`\`md\n\`\`\`action-card\n${card}\n\`\`\`\n\`\`\`\``)).toEqual([])
  expect(actionCardFences(`$$\n\`\`\`action-card\n${card}\n\`\`\`\n$$`)).toEqual([])
})
