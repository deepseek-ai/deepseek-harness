/** Compile request-only inputs against the actual LLM and durable write interfaces. */
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const probePath = resolve(import.meta.dirname, '__request_input_probe.ts')

const probe = `
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionTitleLlmRequestEventData } from '@deepseek-ai/dsh-session-title-llm'
import { createUserMessage, projectFilesToText, projectImagesForTextModel, projectOffloadedImages } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, MessageId, MessageSource, RequestMessage, RequestUserInput } from '@deepseek-ai/dsh-llm'

declare const session: Session
declare const agent: Agent
declare const durable: Message
declare const id: MessageId
declare const source: MessageSource
declare const title: SessionTitleLlmRequestEventData
const input: RequestUserInput = { role: 'user', content: [{ type: 'text', text: 'request' }] }
const request: GenerateOptions = { provider: 'test', model: 'test', messages: [durable, input] }
const files: readonly RequestMessage[] = projectFilesToText([input], () => undefined)
const images: readonly RequestMessage[] = projectImagesForTextModel([input])
const offloaded: readonly RequestMessage[] = projectOffloadedImages([input], () => 'offloaded')
const durableProjection: readonly Message[] = projectImagesForTextModel([durable])
const existing: RequestMessage = durable
type IsAny<T> = 0 extends (1 & T) ? true : false
const requestIsAny: IsAny<RequestMessage> = false
const messageIsAny: IsAny<Message> = false
const inputIsAny: IsAny<RequestUserInput> = false
// @ts-expect-error -- request inputs cannot provide identity without attribution.
const onlyId: RequestMessage = { role: 'user', content: [], id }
// @ts-expect-error -- request inputs cannot provide attribution without identity.
const onlySource: RequestMessage = { role: 'user', content: [], source }
// @ts-expect-error -- exact optional fields reject explicitly undefined identity.
const undefinedId: RequestUserInput = { ...input, id: undefined }
// @ts-expect-error -- exact optional fields reject explicitly undefined attribution.
const undefinedSource: RequestUserInput = { ...input, source: undefined }
// @ts-expect-error -- only user inputs have a request-only alternative.
const assistant: RequestMessage = { role: 'assistant', content: [] }
// @ts-expect-error -- system prompts retain their durable identity and source.
const system: RequestMessage = { role: 'system', content: [] }
// @ts-expect-error -- developer instructions retain their durable identity and source.
const developer: RequestMessage = { role: 'developer', content: [] }
// @ts-expect-error -- tool results retain their durable identity and correlation.
const tool: RequestMessage = { role: 'tool', content: [] }
// @ts-expect-error -- constructing a durable user message requires its source.
createUserMessage(input)
// @ts-expect-error -- Session writes require a durable user message.
session.append('user/message', input, { surfaceOp: 'append' })
// @ts-expect-error -- followups enter durable Session history.
agent.followup(input)
// @ts-expect-error -- injected context enters durable Session history.
agent.inject(input)
// @ts-expect-error -- title requests record their exact durable messages.
const titleMessages: SessionTitleLlmRequestEventData['messages'] = [input]
// @ts-expect-error -- the title event cannot write a request-only input.
session.append('session/title-llm-request', { ...title, messages: [input] })
// @ts-expect-error -- image projections retain request-only inputs and cannot manufacture identity.
const projectedDurable: Message = images[0]!
// @ts-expect-error -- adding an id to a request input does not create a durable message.
session.append('user/message', { ...input, id }, { surfaceOp: 'append' })
// @ts-expect-error -- adding a source to a request input does not create a durable message.
session.append('user/message', { ...input, source }, { surfaceOp: 'append' })
const narrowed = [{ role: 'user', content: [{ type: 'text', text: 'fixed' }] }] as const
// @ts-expect-error -- projections may replace content and cannot preserve narrower content types.
const narrowedProjection: typeof narrowed = projectImagesForTextModel(narrowed)
void [request, files, images, offloaded, durableProjection, existing]
`

it('accepts mixed requests and rejects lightweight inputs at durable message writes', { timeout: 60_000 }, () => {
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve(root, 'tsconfig.host.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  expect(parsed).toBeDefined()
  const options: ts.CompilerOptions = {
    ...parsed!.options,
    composite: false,
    incremental: false,
    noEmit: true,
    declaration: false,
    declarationMap: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
  }
  const base = ts.createCompilerHost(options, true)
  const host: ts.CompilerHost = {
    ...base,
    fileExists: path => resolve(path) === probePath || base.fileExists(path),
    readFile: path => resolve(path) === probePath ? probe : base.readFile(path),
    getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile) {
      return resolve(path) === probePath
        ? ts.createSourceFile(path, probe, languageVersion, true)
        : base.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
    },
  }
  const program = ts.createProgram([probePath], options, host)
  for (const path of ['packages/llm/llm/src/types.ts', 'packages/core/session/src/index.ts', 'packages/session/session-title-llm/src/index.ts']) {
    expect(program.getSourceFile(resolve(root, path)), path).toBeDefined()
  }
  const source = program.getSourceFile(probePath)!
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
  expect(diagnostics.map((diagnostic) => {
    const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1
    return `${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
  })).toEqual([])
})
