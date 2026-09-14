import { expect, expectTypeOf, it } from 'vitest'
import { preparedSchema, processIdSchema, textStreamIdSchema } from '../src/schemas.ts'
import type { SshProcessId, SshTextStreamId } from '../src/schemas.ts'

it('keeps process and text-stream identities distinct while retaining their UUID wire values', () => {
  const wire = 'a25daf3e-c6dd-4bb7-9f39-14f09eb2d155'
  const process = processIdSchema.parse(wire)
  const stream = textStreamIdSchema.parse(wire)
  expectTypeOf(process).toEqualTypeOf<SshProcessId>()
  expectTypeOf(stream).toEqualTypeOf<SshTextStreamId>()
  expectTypeOf(stream).not.toExtend<SshProcessId>()
  expectTypeOf(process).not.toExtend<SshTextStreamId>()
  expectTypeOf<string>().not.toExtend<SshProcessId>()
  expectTypeOf<string>().not.toExtend<SshTextStreamId>()
  expect(JSON.stringify({ process, stream })).toBe(JSON.stringify({ process: wire, stream: wire }))
  expect(preparedSchema.parse({ id: wire, streams: {} }).id).toBe(process)
  expect(processIdSchema.safeParse('invalid').success).toBe(false)
  expect(textStreamIdSchema.safeParse('invalid').success).toBe(false)
})
