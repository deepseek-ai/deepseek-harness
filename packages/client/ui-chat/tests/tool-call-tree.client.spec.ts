import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import type { RunningToolCall, ToolCallBlock } from '../src/client/contract/snapshot.ts'
import {
  MAX_TOOL_CALL_TREE_DEPTH, ToolCallTree,
} from '../src/client/model/tool-call-tree.ts'

const at = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, type, data }) as unknown as SessionEvent

const start = (seq: number, parentCallId: string, subCallId: string): SessionEvent =>
  at(seq, 'tool/ptc-dispatch-start', {
    parentCallId, subCallId, name: 'run_code', arguments: {},
  })

const settle = (seq: number, parentCallId: string, subCallId: string): SessionEvent =>
  at(seq, 'tool/ptc-dispatch', {
    parentCallId, subCallId, name: 'run_code', arguments: {},
    isError: false, content: [],
  })

const root = (callId: string): RunningToolCall => ({
  callId, name: 'run_code', argsRaw: '{}', turn: 1, step: 1,
  time: 1_700_000_000_000, subCalls: [],
})

describe('ToolCallTree', () => {
  it('rejects a self-parenting dispatch edge', () => {
    const tree = new ToolCallTree()
    const roots = [root('root')]

    expect(tree.apply(start(0, 'root', 'root'))).toBe(true)
    expect(tree.projectRunningCalls(roots)).toBe(roots)
  })

  it('rejects a settling edge that would close a multi-call cycle', () => {
    const tree = new ToolCallTree()
    tree.apply(start(0, 'a', 'b'))
    tree.apply(start(1, 'b', 'c'))

    expect(tree.apply(settle(2, 'c', 'a'))).toBe(true)
    expect(tree.projectRunningCalls([root('a')])).toMatchObject([{
      callId: 'a',
      subCalls: [{
        callId: 'b', parentCallId: 'a',
        subCalls: [{ callId: 'c', parentCallId: 'b', subCalls: [] }],
      }],
    }])
  })

  it('accepts an acyclic graph with a shared descendant', () => {
    const tree = new ToolCallTree()
    tree.apply(start(0, 'a', 'b'))
    tree.apply(start(1, 'a', 'c'))
    tree.apply(start(2, 'b', 'd'))
    tree.apply(start(3, 'c', 'd'))

    expect(tree.apply(start(4, 'root', 'a'))).toBe(true)
    expect(tree.projectRunningCalls([root('root')])).toMatchObject([{
      callId: 'root',
      subCalls: [{
        callId: 'a',
        subCalls: [{ callId: 'b' }, { callId: 'c' }],
      }],
    }])
  })

  it('rejects an edge beyond the recursive depth safety limit', () => {
    const tree = new ToolCallTree()
    for (let depth = 1; depth < MAX_TOOL_CALL_TREE_DEPTH; depth++) {
      tree.apply(start(depth, `call-${depth - 1}`, `call-${depth}`))
    }

    expect(tree.apply(start(
      MAX_TOOL_CALL_TREE_DEPTH,
      `call-${MAX_TOOL_CALL_TREE_DEPTH - 1}`,
      `call-${MAX_TOOL_CALL_TREE_DEPTH}`,
    ))).toBe(true)

    let current: ToolCallBlock = tree.projectRunningCalls([root('call-0')])[0]!
    let depth = 1
    while (current.subCalls.length > 0) {
      current = current.subCalls[0]!
      depth++
    }
    expect(depth).toBe(MAX_TOOL_CALL_TREE_DEPTH)
    expect(current.callId).toBe(`call-${MAX_TOOL_CALL_TREE_DEPTH - 1}`)
  })
})
