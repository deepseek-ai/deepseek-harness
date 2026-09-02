import { describe, expect, it } from 'vitest'
import type { RequestView } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  TrajectoryContribution, TrajectoryConversationViewNode, TrajectoryRequestHeaderState,
} from '../src/client/trajectory-contract.ts'
import { TrajectorySnapshotBuilder } from '../src/client/trajectory-snapshot-builder.ts'

const EMPTY_LOCATION_DATA_SOURCE = { getSnapshot: () => undefined, subscribe: () => () => {} }
const EMPTY_LOCATION_DATA = { get: () => undefined, source: () => EMPTY_LOCATION_DATA_SOURCE }

function assistantRequest(startSeq: number, step: number): Extract<RequestView, { purpose: 'assistant' }> {
  return {
    purpose: 'assistant',
    startSeq,
    turn: 1,
    step,
    startedAt: startSeq,
    completedAt: startSeq + 1,
    status: 'complete',
  }
}

function contribution(
  key: string,
  anchorSeq: number,
  data: TrajectoryContribution,
): TrajectoryConversationViewNode {
  return {
    key, kind: key, id: key, target: 'trajectory', anchorSeq,
    location: { kind: 'session' },
    data,
  }
}

function stepLocation(turn: number, step: number): TrajectoryRequestHeaderState['location'] {
  const data = EMPTY_LOCATION_DATA
  const stepLocation = {
    turn,
    step,
    start: undefined,
    end: undefined,
    status: 'unknown' as const,
    data,
  }
  const turnLocation = {
    turn,
    start: undefined,
    end: undefined,
    status: 'unknown' as const,
    steps: [stepLocation],
    data,
  }
  return { kind: 'step', turn: turnLocation, step: stepLocation }
}

function compactionRequest(startSeq: number): Extract<RequestView, { purpose: 'compaction' }> {
  return {
    purpose: 'compaction',
    startSeq,
    turn: null,
    step: 0,
    startedAt: startSeq,
    completedAt: null,
    status: 'running',
  }
}

describe('TrajectorySnapshotBuilder', () => {
  it('inherits one request header across requests without repeating its prompt change', () => {
    const prompt = {
      config: { provider: 'test', model: 'test' },
      system: 'one initial prompt',
      tools: [],
    }
    const nodes: TrajectoryConversationViewNode[] = [
      {
        key: 'header',
        kind: 'trajectory-request-header',
        id: '2',
        target: 'trajectory',
        anchorSeq: 2,
        location: { kind: 'session' },
        data: {
          kind: 'request-header',
          header: {
            seq: 2,
            time: 2,
            prompt,
            change: { seq: 2, time: 2, kind: 'initial' },
            location: { kind: 'session' },
          },
        },
      },
      ...[assistantRequest(3, 1), assistantRequest(5, 2)].map(request => ({
        key: `assistant:${request.step}`,
        kind: 'trajectory-assistant-step',
        id: `1:${request.step}`,
        target: 'trajectory' as const,
        anchorSeq: request.startSeq,
        location: { kind: 'session' as const },
        data: { kind: 'assistant' as const, partial: null, request },
      })),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['one initial prompt', 'one initial prompt'])
    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.promptChange?.kind
      : undefined)).toEqual(['initial', undefined])
  })

  it('retains a same-step prompt change when a later series header supplies the latest snapshot', () => {
    const initial = {
      config: { provider: 'test', model: 'test' },
      system: 'initial prompt',
      tools: [],
    }
    const changed = { ...initial, system: 'changed prompt' }
    const nodes: TrajectoryConversationViewNode[] = [
      contribution('header:initial', 2, {
        kind: 'request-header',
        header: {
          seq: 2,
          time: 2,
          prompt: initial,
          change: { seq: 2, time: 2, kind: 'initial' },
          location: { kind: 'session' },
        },
      }),
      contribution('assistant:1', 3, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(3, 1),
      }),
      contribution('header:change', 5, {
        kind: 'request-header',
        header: {
          seq: 5,
          time: 5,
          prompt: changed,
          change: { seq: 5, time: 5, kind: 'system', previous: initial },
          location: stepLocation(1, 2),
        },
      }),
      contribution('header:series', 6, {
        kind: 'request-header',
        header: {
          seq: 6,
          time: 6,
          prompt: changed,
          location: stepLocation(1, 2),
        },
      }),
      contribution('assistant:2', 7, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(7, 2),
      }),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['initial prompt', 'changed prompt'])
    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.promptChange?.seq
      : undefined)).toEqual([2, 5])
  })

  it('indexes exact step headers and the active tool schema without backward scans', () => {
    const basePrompt = {
      config: { provider: 'test', model: 'base' },
      system: 'base prompt',
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    }
    const exactPrompt = {
      config: { provider: 'test', model: 'exact' },
      system: 'exact prompt',
      tools: [{ name: 'edit', description: 'Edit', parameters: { type: 'object' } }],
    }
    const nodes: TrajectoryConversationViewNode[] = [
      contribution('header:base', 2, {
        kind: 'request-header',
        header: {
          seq: 2,
          time: 2,
          prompt: basePrompt,
          change: { seq: 2, time: 2, kind: 'initial' },
          location: { kind: 'session' },
        },
      }),
      contribution('assistant:1', 3, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(3, 1),
      }),
      contribution('assistant:2', 5, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(5, 2),
      }),
      contribution('header:exact', 6, {
        kind: 'request-header',
        header: {
          seq: 6,
          time: 6,
          prompt: exactPrompt,
          change: { seq: 6, time: 6, kind: 'system', previous: basePrompt },
          location: stepLocation(1, 2),
        },
      }),
      contribution('tool', 7, {
        kind: 'tool',
        root: {
          callId: 'call-edit',
          name: 'edit',
          argsRaw: '{}',
          turn: 1,
          step: 2,
          time: 7,
          subCalls: [],
        },
      }),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['base prompt', 'exact prompt'])
    expect(snapshot.callSchemas.get('call-edit')).toEqual(exactPrompt.tools[0])
  })

  it('applies session boundaries and turn errors with linear request indexes', () => {
    const nodes: TrajectoryConversationViewNode[] = [
      ...[assistantRequest(1, 1), assistantRequest(3, 2)].map(request => contribution(
        `assistant:${request.step}`,
        request.startSeq,
        { kind: 'assistant', partial: null, request },
      )),
      contribution('turn-end', 5, {
        kind: 'turn-end',
        turn: 1,
        time: 5,
        error: 'turn failed',
        errorCode: 'AUTH',
      }),
      contribution('compact:10', 10, {
        kind: 'compaction',
        request: compactionRequest(10),
      }),
      contribution('compact:12', 12, {
        kind: 'compaction',
        request: compactionRequest(12),
      }),
      contribution('session-end:14', 14, { kind: 'session-end', seq: 14, time: 14 }),
      contribution('session-end:16', 16, { kind: 'session-end', seq: 16, time: 16 }),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests).toMatchObject([
      { purpose: 'assistant', step: 1, status: 'complete' },
      {
        purpose: 'assistant', step: 2, status: 'error', error: 'turn failed', errorCode: 'AUTH',
      },
      { purpose: 'compaction', startSeq: 10, status: 'error', completedAt: 16 },
      { purpose: 'compaction', startSeq: 12, status: 'error', completedAt: 14 },
    ])
  })

  it('keeps cached contribution order across content updates and structural inserts', () => {
    const builder = new TrajectorySnapshotBuilder()
    const first = contribution('assistant:1', 1, {
      kind: 'assistant', partial: null, request: assistantRequest(1, 1),
    })
    const last = contribution('assistant:3', 5, {
      kind: 'assistant', partial: null, request: assistantRequest(5, 3),
    })
    expect(builder.replace({ nodes: [last, first] }).requests.map(request => request.startSeq))
      .toEqual([1, 5])

    const updatedLast = contribution('assistant:3', 5, {
      kind: 'assistant',
      partial: null,
      request: { ...assistantRequest(5, 3), status: 'error', error: 'failed' },
    })
    expect(builder.apply({ upserts: [updatedLast] }).requests.map(request => request.startSeq))
      .toEqual([1, 5])

    const middle = contribution('assistant:2', 3, {
      kind: 'assistant', partial: null, request: assistantRequest(3, 2),
    })
    expect(builder.apply({ upserts: [middle] }).requests.map(request => request.startSeq))
      .toEqual([1, 3, 5])
  })
})
