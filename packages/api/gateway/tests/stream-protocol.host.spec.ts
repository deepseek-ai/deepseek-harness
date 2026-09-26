import { describe, expect, it } from 'vitest'
import {
  parseRemoteStreamClientMessage,
  parseRemoteStreamServerMessage,
} from '../src/stream-protocol.ts'

describe('Remote stream wire protocol', () => {
  it('accepts every client message variant', () => {
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'open', streamId: 'stream-1', endpoint: 'feed/follow', payload: { cursor: 1 },
    }))).toEqual({
      type: 'open', streamId: 'stream-1', endpoint: 'feed/follow', payload: { cursor: 1 },
    })
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'cancel', streamId: 'stream-1',
    }))).toEqual({ type: 'cancel', streamId: 'stream-1' })
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1', value: { line: 'ls\n' },
    }))).toEqual({ type: 'item', streamId: 'stream-1', value: { line: 'ls\n' } })
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1',
    }))).toEqual({ type: 'item', streamId: 'stream-1' })
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'end', streamId: 'stream-1',
    }))).toEqual({ type: 'end', streamId: 'stream-1' })
  })

  it.each([
    { type: 'open', streamId: '', endpoint: 'feed/follow', payload: {} },
    { type: 'open', streamId: 'stream-1', endpoint: '', payload: {} },
    { type: 'open', streamId: 'stream-1', endpoint: 'feed/follow' },
    { type: 'cancel', streamId: 'stream-1', extra: true },
    { type: 'item', streamId: '', value: 'line' },
    { type: 'item', streamId: 'stream-1', value: 'line', extra: true },
    { type: 'item', streamId: 'stream-1', endpoint: 'feed/follow' },
    { type: 'end', streamId: '' },
    { type: 'end', streamId: 'stream-1', value: 'line' },
    { type: 'unknown', streamId: 'stream-1' },
  ])('rejects an invalid client message: %j', (message) => {
    expect(() => parseRemoteStreamClientMessage(JSON.stringify(message)))
      .toThrow('api gateway: invalid Remote stream client message')
  })

  it('rejects an uplink item whose value is not lossless JSON', () => {
    expect(() => parseRemoteStreamClientMessage('{"type":"item","streamId":"stream-1","value":-0}'))
      .toThrow('api gateway: invalid Remote stream client message')
  })

  it('accepts every server message variant', () => {
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1', value: null,
    }))).toEqual({ type: 'item', streamId: 'stream-1', value: null })
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1',
    }))).toEqual({ type: 'item', streamId: 'stream-1' })
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'error',
      streamId: 'stream-1',
      error: { code: 'offline', message: 'connection lost', details: {} },
    }))).toEqual({
      type: 'error',
      streamId: 'stream-1',
      error: { code: 'offline', message: 'connection lost', details: {} },
    })
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'end', streamId: 'stream-1',
    }))).toEqual({ type: 'end', streamId: 'stream-1' })
  })

  it.each([
    { type: 'item', streamId: '', value: 'item' },
    { type: 'item', streamId: 'stream-1', extra: true },
    { type: 'end', streamId: 'stream-1', extra: true },
    { type: 'error', streamId: 'stream-1', error: [] },
    { type: 'error', streamId: 'stream-1', error: { code: 1, message: 'failure', details: {} } },
    { type: 'error', streamId: 'stream-1', error: { code: 'failed', message: 1, details: {} } },
    { type: 'error', streamId: 'stream-1', error: { code: 'failed', message: 'failure', details: [] } },
    { type: 'unknown', streamId: 'stream-1' },
  ])('rejects an invalid server message: %j', (message) => {
    expect(() => parseRemoteStreamServerMessage(JSON.stringify(message)))
      .toThrow('api gateway: invalid Remote stream server message')
  })

  it.each(['not json', 'null', '[]', '1'])('rejects a non-message payload: %s', (text) => {
    expect(() => parseRemoteStreamServerMessage(text)).toThrow('api gateway: Remote stream message')
  })
})
