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

  // Historical run_code schemas from tool-executor-ptc use this literal prefix.
  it.each([
    ['Execute a program in `typescript` against the available tools.', 'typescript'],
    ['Execute a program in `python` against the available tools.', 'python'],
    ['Execute a program in `Python` against the available tools.', 'python'],
    ['Execute a program in `ruby` against the available tools.', undefined],
    ['Execute a program in `typescript` against the available tools. Example: call a Python tool.', 'typescript'],
    ['Execute a program in `python` against the available tools. Example: call a TypeScript tool.', 'python'],
    ['Execute a program. Examples use TypeScript and Python.', undefined],
    ['Execute a program against the available tools.', undefined],
    ['An example: Execute a program in `typescript`.', undefined],
    ['execute a program in `typescript` against the available tools.', undefined],
  ])('reads only the leading tool-level declaration: %s', (description, language) => {
    const schemaDetail = JSON.stringify({
      description,
      parameters: { properties: { code: { description: "The program to execute, following this tool's execution instructions." } } },
    })
    expect(codeProgram({ ...CELL, schemaDetail })?.language).toBe(language)
  })

  it.each([
    ['typescript', 'A TypeScript program.', 'typescript'],
    ['python', 'A Python program.', 'python'],
    ['typescript', 'A Python program.', undefined],
    ['python', 'A TypeScript program.', undefined],
    ['typescript', 'A TypeScript or Python program.', undefined],
    ['python', 'A TypeScript or Python program.', undefined],
    ['ruby', 'A TypeScript program.', undefined],
    ['ruby', 'A Python program.', undefined],
  ])('combines the declaration %s with the legacy hint %s', (declared, description, language) => {
    const schemaDetail = JSON.stringify({
      description: `Execute a program in \`${declared}\` against the available tools.`,
      parameters: { properties: { code: { description } } },
    })
    expect(codeProgram({ ...CELL, schemaDetail })?.language).toBe(language)
  })

  it.each(['typescript', 'python'])('uses the %s declaration without a parameter description', (language) => {
    for (const description of [undefined, 42]) {
      const schemaDetail = JSON.stringify({
        description: `Execute a program in \`${language}\` against the available tools.`,
        parameters: { properties: { code: { description } } },
      })
      expect(codeProgram({ ...CELL, schemaDetail })?.language).toBe(language)
    }
  })

  it.each([undefined, 42, 'Execute a TypeScript program against the available tools.'])(
    'retains legacy hints without an explicit declaration: %s', (description) => {
      const schemaDetail = JSON.stringify({
        description,
        parameters: { properties: { code: { description: 'A Python program.' } } },
      })
      expect(codeProgram({ ...CELL, schemaDetail })?.language).toBe('python')
    },
  )

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
