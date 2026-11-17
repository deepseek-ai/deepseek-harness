/** The temporary file and byte count a PDF conversion reports, which the real Office export lane asserts. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { createToolResultMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, type SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { convertedPdfFiles } from './fixtures/real-office.ts'

const temporary = '/h/.dsh/office-kit/outputs/session-0123456789abcdef01234567/2f0f8c3e-7d1b-4c1e-9b0a-0d5e6f7a8b9c/input.pdf'

/** Record native tool results carrying one text block each. */
function results(texts: readonly string[], isError = false): readonly SessionEvent[] {
  const session = Session.create(brandString<SessionId>('converted-pdf'))
  for (const text of texts) {
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: brandString<ToolCallId>('convert'), content: [{ type: 'text', text }], isError }),
    }, { surfaceOp: 'append' })
  }
  return session.snapshotEvents()
}

it('collects the temporary file and byte count a PDF conversion reports', () => {
  expect(convertedPdfFiles(results([`Converted input.docx to pdf (2048 bytes): ${temporary}\nCopy this temporary file to its destination with the shell now.`])))
    .toEqual([{ bytes: 2048, file: temporary }])
  expect(convertedPdfFiles(results([`Converted input.docx to pdf (4096 bytes, 3 pages): ${temporary}`])))
    .toEqual([{ bytes: 4096, file: temporary }])
})

it('ignores failed results, other formats, and render summaries', () => {
  expect(convertedPdfFiles(results([`Converted input.docx to pdf (2048 bytes): ${temporary}`], true))).toEqual([])
  expect(convertedPdfFiles(results(['Converted input.docx to docx (1024 bytes): /h/outputs/input.docx']))).toEqual([])
  expect(convertedPdfFiles(results(['Rendered 2 images of input.docx (3 in the document) at 144 DPI.']))).toEqual([])
})
