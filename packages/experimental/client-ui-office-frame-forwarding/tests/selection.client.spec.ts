/** Native selection payloads retain document geometry. */
import { expect, test } from 'vitest'
import { parseCellCursor, parseGraphicSelection } from '../src/client/selection.ts'

// Captured from the pinned native Impress engine after selecting the first color-block object.
const graphic = '720, 720, 3239, 2159, 0, {"id":"50492031616","type":33,"OrdNum":0,"handles":{"kinds":{"rectangle":{"1":[{"id":"0","kind":"1","pointer":"11","point":{"x":"720","y":"720"}}]},"poly":"","custom":"","anchor":"","others":""}}}'

test('Impress selection outlines the native object bounds in twips', () => {
  expect(parseGraphicSelection(graphic)).toEqual({ x: 720, y: 720, width: 3239, height: 2159 })
})

test('Calc cell cursor preserves cell extents and excludes row and column indices', () => {
  expect(parseCellCursor('0, 0, 4799, 1799, 0, 0')).toEqual({ x: 0, y: 0, width: 4799, height: 1799 })
  expect(parseCellCursor('-240, 1800, 1200, 300, 3, 6')).toEqual({ x: -240, y: 1800, width: 1200, height: 300 })
  expect(parseCellCursor('0, 0, 0, 0, 0, 0')).toEqual({ x: 0, y: 0, width: 0, height: 0 })
})

test.each(['EMPTY', '', '0,0,1', '0,0,1,1', '0,0,-1,1,0,0', '0,0,1,1,-1,0', '0,0,1,1,0,-1',
  '0,,1,1,0,0', '0,0,1.5,1,0,0', '0,0,Infinity,1,0,0', '0,0,1,1,0,0,0'])('clears an invalid cell cursor: %s', (payload) => {
  expect(parseCellCursor(payload)).toBeUndefined()
})

test.each(['', ', {}', ', {"isWriterGraphic":true}', ', {"handles":null}'])('ignores trailing graphic properties: %s', (properties) => {
  expect(parseGraphicSelection('-10, 20, 30, 40, 9000' + properties)).toEqual({ x: -10, y: 20, width: 30, height: 40 })
})

test.each(['EMPTY', '', '0,0,1,1', '0,0,1,1,0,', '0,,1,1,0', '0,0,-1,1,0', '0,0,1,-1,0',
  '0,0,1,1,NaN', '0,0,1,1,9007199254740992', '0,0,1,1,0 {}'])('clears a malformed graphic selection: %s', (payload) => {
  expect(parseGraphicSelection(payload)).toBeUndefined()
})
