/**
 * Endpoint-named mock for Typert Remote traffic: a table of unary answers and
 * stream scripts keyed by `<namespace>/<method>`, scripted-stream control, a
 * carrier log, and the Connection carrier face the `connection` plugin
 * accepts through explicit installation or a page transport. Values are whatever the test
 * registers; the only declaration is whether an endpoint is unary or a
 * stream. Browser-safe: no DOM, React, or Node imports, no runtime import
 * from another harness package.
 * @module @deepseek-ai/dsh-remote-mock
 */
export { RemoteMock, ok } from './remote-mock.ts'
export type { OpenStreams, RemoteMockOptions, RemoteTable, StreamFilter, UnaryRuleFn } from './remote-mock.ts'
export { frames, openStream } from './streams.ts'
export type { StreamHandle, StreamScript } from './streams.ts'
export type { LoggedCall, LoggedMiss, LoggedStream, MockLog } from './log.ts'
export type { MockedRemote } from './remote-proxy.ts'
