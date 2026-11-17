import { expect, it } from 'vitest'
import { actionCardFences } from '../src/fence.ts'

it('reads top-level action-card fences of either marker in text order, matching the language as the Chat client does', () => {
  expect(actionCardFences('Answer.\n\n```action-card\n{"a":1}\n```\n')).toEqual(['{"a":1}'])
  expect(actionCardFences('x\n~~~~ Action-Card extra words\n{"b":2}\n~~~~\nafter')).toEqual(['{"b":2}'])
  expect(actionCardFences('```action-card{"c":3}\n{"c":3}\n```')).toEqual(['{"c":3}'])
  expect(actionCardFences('```action-card\r\n{"d":4}\r\n```')).toEqual(['{"d":4}'])
  expect(actionCardFences('```action-card\n1\n```\ntext\n```action-card\n2\n```')).toEqual(['1', '2'])
})

it('removes the opening indentation from content and runs an unclosed fence to the end of the text', () => {
  expect(actionCardFences('  ```action-card\n  {"a":1}\n    {"b":2}\n   ```')).toEqual(['{"a":1}\n  {"b":2}'])
  expect(actionCardFences('text\n```action-card\n{"open":true}')).toEqual(['{"open":true}'])
  expect(actionCardFences('````action-card\n{"a":1}\n```\n````')).toEqual(['{"a":1}\n```'])
})

it('reads fences in list items, closing them by the item content column so a later card still counts', () => {
  expect(actionCardFences('- ```json\n  {"a":1}\n  ```\n\nText.\n\n```action-card\n{"b":2}\n```')).toEqual(['{"b":2}'])
  expect(actionCardFences('10. ```action-card\n    {"c":3}\n       ```\nafter')).toEqual(['{"c":3}'])
  expect(actionCardFences('- ```action-card\n  {"d":4}\n      ```\n  ```')).toEqual(['{"d":4}\n    ```'])
  expect(actionCardFences('1. Step\n   ```action-card\n   {"e":5}\n   ```')).toEqual(['{"e":5}'])
})

it('skips other languages, fences nested in another fence or a block quote, deeper indentation and backtick info strings', () => {
  expect(actionCardFences('No card here.')).toEqual([])
  expect(actionCardFences('action-card mentioned in prose only')).toEqual([])
  expect(actionCardFences('```json\n{"action-card":true}\n```')).toEqual([])
  expect(actionCardFences('```action-cards\n{}\n```')).toEqual([])
  expect(actionCardFences('````md\n```action-card\n{"e":5}\n```\n````')).toEqual([])
  expect(actionCardFences('    ```action-card\n    {"f":6}\n    ```')).toEqual([])
  expect(actionCardFences('- Item\n  - Nested\n    ```action-card\n    {"f":6}\n    ```')).toEqual([])
  expect(actionCardFences('> ```action-card\n> {"h":8}\n> ```')).toEqual([])
  expect(actionCardFences('```action-card `x`\n{"g":7}\n```')).toEqual([])
})
