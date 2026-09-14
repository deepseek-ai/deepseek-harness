/** Recorded PTC argument validation and historical language selection. */
import { describe, expect, it } from 'vitest'
import { codeProgram } from '../src/client/code-program.ts'
import type { TrajectoryCellProps } from '../src/client/trajectory-record.ts'

const CELL: TrajectoryCellProps = {
  index: 1, kind: 'tool', toolName: 'run_code', text: 'run_code · {}', timeSeconds: 1,
  inputDetail: JSON.stringify({ code: 'return 42\n', description: 'Compute the answer' }),
}

describe('recorded code programs', () => {
  it('keeps the program and arguments verbatim', () => {
    expect(codeProgram(CELL)).toEqual({
      rawInput: CELL.inputDetail,
      source: 'return 42\n', description: 'Compute the answer',
      arguments: { code: 'return 42\n', description: 'Compute the answer' }, language: undefined,
    })
  })

  it.each([
    ['The program: the body of an async TypeScript function.', 'typescript'],
    ['The program: the body of an async Python function.', 'python'],
    ['A TypeScript or Python program.', undefined],
    ['An executable program.', undefined],
  ])('uses the recorded parameter description %s', (description, language) => {
    const schemaDetail = JSON.stringify({ parameters: { properties: { code: { description } } } })
    expect(codeProgram({ ...CELL, schemaDetail })?.language).toBe(language)
  })

  it.each([undefined, '{', '{}', 'null', '[]'])('keeps missing or unusable schemas plain: %s', (schemaDetail) => {
    expect(codeProgram({ ...CELL, ...(schemaDetail === undefined ? {} : { schemaDetail }) })?.language).toBeUndefined()
  })

  it('uses the first nonempty source line when a description is unavailable', () => {
    const source = '\n  const x = 1\nreturn x\n'
    for (const description of [undefined, '', '   ']) {
      expect(codeProgram({ ...CELL, inputDetail: JSON.stringify({ code: source, description }) }))
        .toMatchObject({ source, description: 'const x = 1' })
    }
  })

  it('retains empty source and unknown argument fields for JSON inspection', () => {
    expect(codeProgram({ ...CELL, inputDetail: '{"code":"","extra":true}' }))
      .toMatchObject({ source: '', description: '', arguments: { code: '', extra: true } })
  })

  it.each([undefined, '{', '[]', 'null', '42', '{}', '{"code":42}', '{"code":"x","description":[]}' ])(
    'declines incomplete or unsupported arguments: %s', (inputDetail) => {
      const cell = { ...CELL }
      if (inputDetail === undefined) delete cell.inputDetail
      else cell.inputDetail = inputDetail
      expect(codeProgram(cell)).toBeUndefined()
    },
  )

  it('uses recorded tool metadata independently of display text', () => {
    expect(codeProgram({ ...CELL, text: 'Execute program' })?.source).toBe('return 42\n')
    const withoutName = { ...CELL }
    delete withoutName.toolName
    expect(codeProgram(withoutName)).toBeUndefined()
    const rawInput = ' { "code": "return 42" }\n'
    expect(codeProgram({ ...CELL, inputDetail: rawInput })?.rawInput).toBe(rawInput)
  })

  it('does not specialize other tools or non-tool records', () => {
    expect(codeProgram({ ...CELL, kind: 'message' })).toBeUndefined()
    expect(codeProgram({ ...CELL, toolName: 'run_code_extra' })).toBeUndefined()
    expect(codeProgram({ ...CELL, kind: 'subtool' })?.source).toBe('return 42\n')
  })
})
