/** Exact Host projections and stopped output without invented file effects. */
import { expect, it, vi } from 'vitest'
import * as Patch from '@deepseek-ai/dsh-fs-patch'
import { presentPatchCall, presentPatchResult } from '../src/apply-patch-presentation.ts'
import { renderPatch, patchPresentationMeta, type PatchToolValue } from '../src/apply-patch-output.ts'
import { stoppedFromMeta } from '../src/diff.ts'
import { add, move, patch, remove, setup, update } from './patch/harness.ts'

it('previews every operation using raw paths, counting distinct files including move endpoints', async () => {
  const text = patch(add('a'), update('b'), remove('c'), move('d', 'e'), '*** Update File: empty\n@@\n+insert', update('b', 'new', 'last'))
  const expected = { card: 'diff', title: 'Apply patch (6 files)', diffs: [
    { path: 'a', oldText: null, newText: 'new\n' }, { path: 'b', oldText: 'old', newText: 'new' },
    { path: 'd', oldText: 'old', newText: 'new' }, { path: 'empty', oldText: null, newText: 'insert' },
    { path: 'b', oldText: 'new', newText: 'last' },
  ], locations: ['a', 'b', 'c', 'd', 'e', 'empty'].map(path => ({ path })) }
  expect(presentPatchCall(text)).toEqual(expected)
  const t = await setup()
  expect(t.ctx.tools.get('apply_patch')?.presentCall?.({ input: text })).toEqual(expected)
  expect(presentPatchCall(patch(remove('only')))).toEqual({ card: 'diff', title: 'Apply patch (1 file)', diffs: [], locations: [{ path: 'only' }] })
  expect(presentPatchCall('invalid')).toBeUndefined()
})

it('propagates unexpected parser defects', () => {
  const defect = new Error('parser defect')
  const spy = vi.spyOn(Patch, 'parsePatch').mockImplementation(() => { throw defect })
  try { expect(() => presentPatchCall('text')).toThrow(defect) } finally { spy.mockRestore() }
})

it('falls back on failed or missing metadata and titles known stopped diffs', async () => {
  const diffs = [{ path: 'a', oldText: 'old', newText: 'new' }]
  const result = { isError: false, content: [], meta: { diffs } }
  expect(presentPatchResult({ ...result, isError: true })).toBeUndefined()
  expect(presentPatchResult({ isError: false, content: [] })).toBeUndefined()
  expect(presentPatchResult(result)).toEqual({ card: 'diff', title: 'Apply patch', diffs })
  const stopped = { ...result, meta: { diffs, stopped: true } }
  expect(presentPatchResult(stopped)).toEqual({ card: 'diff', title: 'Apply patch (stopped)', diffs })
  const t = await setup()
  expect(t.ctx.tools.get('apply_patch')?.presentResult?.({ input: patch() }, stopped))
    .toEqual({ card: 'diff', title: 'Apply patch (stopped)', diffs })
})

it.each([undefined, null, [], 'stopped', {}, { stopped: 'true' }, { stopped: false }])('rejects a malformed stopped flag %j', (meta) => {
  expect(stoppedFromMeta(meta)).toBe(false)
})

it('stores no diff for creations or for removals without a bounded basis', () => {
  const value: PatchToolValue = { phase: 'commit', cancelled: false, affectedPaths: ['a', 'b'], operations: [
    { index: 0, kind: 'delete', path: 'a', patchLine: 2, status: 'completed', changes: [{ path: 'a', before: null, after: null }] },
    { index: 1, kind: 'add', path: 'd', patchLine: 3, status: 'completed', changes: [{ path: 'd', before: null, after: 'created\n' }] },
    { index: 2, kind: 'delete', path: 'e', patchLine: 5, status: 'completed', changes: [{ path: 'e', before: 'gone\n', after: null }] },
    { index: 3, kind: 'update', path: 'b', patchLine: 6, status: 'failed', code: 'FS_PERMISSION_DENIED', message: 'denied' },
    { index: 4, kind: 'add', path: 'c', patchLine: 7, status: 'skipped' },
  ] }
  expect(patchPresentationMeta(value)).toEqual({ stopped: true, diffs: [{ path: 'e', oldText: 'gone\n', newText: '' }] })
  expect(renderPatch(value)).toBe('Patch stopped after 3 of 5 operations.\nCompleted:\nA d\nD a\nD e\nFailed:\n'
    + '- operation 4 (update b, patch line 6): denied\nNot executed:\n- operation 5 (add c)')
})

it('reports cancellation and a move failure with no written destination', () => {
  const value: PatchToolValue = { phase: 'commit', cancelled: true, affectedPaths: [], operations: [
    { index: 0, kind: 'move', path: 'a', destination: 'b', patchLine: 2, status: 'failed', message: 'cancelled', changes: [] },
    { index: 1, kind: 'delete', path: 'c', patchLine: 7, status: 'skipped' },
  ] }
  expect(renderPatch(value)).toBe('Patch stopped after 0 of 2 operations.\nFailed:\n'
    + '- operation 1 (move a -> b, patch line 2): cancelled\nNot executed:\n- operation 2 (delete c)')
})
