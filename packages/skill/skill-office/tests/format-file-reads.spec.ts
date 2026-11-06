/** Format-file read detection counts only successful reads of the office skill's own files before authoring. */
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { formatFileReads } from './fixtures/real-office.ts'

const base = '/assets/office'
const skillText = `<skill_content name="office">\n<skill_resources>\nBase directory for this skill: ${base}\nResolve relative paths.\n</skill_resources>`

function session(): Session {
  const created = Session.create(SessionId('format-file-reads'))
  created.append('user/message', createUserMessage({
    content: [{ type: 'text', text: skillText }], source: { kind: 'skill-invocation', name: 'office', form: 'instructions' },
  }), { surfaceOp: 'append' })
  return created
}

function nativeCall(target: Session, callId: string, name: string, args: object, isError = false): void {
  target.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) })
  target.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'result' }], isError }),
  }, { surfaceOp: 'append' })
}

function ptcCall(target: Session, subCallId: string, name: string, args: Record<string, string>, isError = false): void {
  const ids = { rootCallId: ToolCallId('program'), parentCallId: ToolCallId('program'), subCallId: ToolCallId(subCallId) }
  target.append('tool/ptc-dispatch-start', { ...ids, name, arguments: args })
  target.append('tool/ptc-dispatch', { ...ids, name, arguments: args, isError, content: [{ type: 'text', text: 'result' }] })
}

it('counts successful native and PTC reads of the loaded office directory or an office/<format>.md path', () => {
  const recorded = session()
  nativeCall(recorded, 'docx', 'read', { file_path: `${base}/docx.md` })
  ptcCall(recorded, 'program:1', 'read', { file_path: 'office-skills/office/xlsx.md' })
  nativeCall(recorded, 'pptx', 'read', { file_path: 'C:\\assets\\office\\pptx.md' })
  expect(formatFileReads(recorded.snapshotEvents())).toEqual(['docx', 'xlsx', 'pptx'])
})

it.each([
  ['a failed native read', (target: Session) => { nativeCall(target, 'read', 'read', { file_path: `${base}/docx.md` }, true) }],
  ['a failed PTC read', (target: Session) => { ptcCall(target, 'program:1', 'read', { file_path: `${base}/docx.md` }, true) }],
  ['a shell command naming the file', (target: Session) => { nativeCall(target, 'bash', 'bash', { command: 'echo docx.md' }) }],
  ['a same-named file in another directory', (target: Session) => { nativeCall(target, 'read', 'read', { file_path: '/workspace/notes/docx.md' }) }],
  ['a read after the first file write', (target: Session) => {
    nativeCall(target, 'write', 'write', { file_path: 'report.docx', content: 'x' })
    nativeCall(target, 'read', 'read', { file_path: `${base}/docx.md` })
  }],
  ['a read after a Python script runs', (target: Session) => {
    ptcCall(target, 'program:1', 'bash', { command: 'python3 edit_docx.py' })
    ptcCall(target, 'program:2', 'read', { file_path: `${base}/docx.md` })
  }],
])('does not count %s', (_label, record) => {
  const recorded = session()
  record(recorded)
  expect(formatFileReads(recorded.snapshotEvents())).toEqual([])
})
