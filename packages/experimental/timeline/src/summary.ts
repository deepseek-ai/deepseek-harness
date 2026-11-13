// Auxiliary-call mechanism adapted from kermanx/dsh-progress-check (MIT).
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { ZodError } from 'zod'
import type { Config } from './config.ts'
import type { IntervalReport, StoredRequest, Summary } from './records.ts'
import { languageInstruction, outputLanguage } from './policy.ts'
import { parseSummary, reportStyle } from './prompt.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'timeline-report': true
  }
}

interface SummaryInput {
  draft: IntervalReport
  request: StoredRequest
  children: readonly IntervalReport[]
  previous: Summary | undefined
  settings: Pick<Config, 'language' | 'uiLanguage' | 'levelPrompts' | 'summaryPrompt' | 'maxResponseBytes' | 'reportMaxTokens' | 'reportReasoningEffort'>
  record: (request: StoredRequest) => Promise<void>
}

/**
 * Query and validate one tool-free report, recording each request before dispatch.
 * @param llm - the model service used to generate the report.
 * @param input - input to validate.
 * @param signal - cancellation signal for this operation.
 * @returns the validated model report.
 */
export async function summarizeReport(
  llm: Context['llm'],
  input: SummaryInput,
  signal: AbortSignal,
): Promise<Summary> {
  const { draft, request: snapshot, children, previous, settings, record } = input
  const route = {
    provider: snapshot.provider,
    model: snapshot.model,
    purpose: 'timeline-report' as const,
    ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
  }
  const selectedLanguage = outputLanguage(settings.language, settings.uiLanguage)
  const language = languageInstruction(selectedLanguage)
  const extra = settings.levelPrompts[draft.level]?.trim()
  const style = `${reportStyle}\n\n${language}`
  const question = (
    `Write a Timeline report for ${new Date(draft.start).toISOString()} to ${new Date(draft.end).toISOString()}.\n` +
    (children.length === 0
      ? 'Report changes supported by the available record for this period. Use earlier work as background.\n\n'
      : 'Use the completed child reports as evidence for this period.\n\n') +
    `Reporting focus:\n${settings.summaryPrompt}${extra ? `\n\nLevel guidance:\n${extra}` : ''}\n\n` +
    (children.length === 0 ? `${style}\n\n` : '') +
    (children.length === 0
      ? previous === undefined
        ? ''
        : `Previous summary (for comparison only):\n${JSON.stringify(previous)}`
      : 'Combine these completed child reports:\n' +
        JSON.stringify(
          children.map(item => ({
            start: new Date(item.start).toISOString(),
            end: new Date(item.end).toISOString(),
            summary: item.summary,
          })),
        ))
  ).trimEnd()
  const request: StoredRequest =
    children.length === 0
      ? {
        ...route,
        ...(typeof snapshot.system === 'string' ? { system: snapshot.system } : {}),
        messages: [
          ...snapshot.messages,
          { role: 'user', content: [{ type: 'text', text: question }] },
        ],
      }
      : {
        ...route,
        system: style,
        messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
      }
  const query = async (request: StoredRequest): Promise<string> => {
    // The report envelope owns its controls; only its message prefix comes from the main task.
    signal.throwIfAborted()
    const prepared = await llm.prepareCall(
      { provider: route.provider, model: route.model },
      signal,
      (_controls, model) => {
        const requested = settings.reportReasoningEffort
        const effort = model.reasoning?.efforts.find(item => item.id === requested)?.id
        if (requested !== undefined && effort === undefined)
          throw new Error(`Timeline report model ${route.model} does not support reasoning effort "${requested}".`)
        return {
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          maxTokens: Math.min(model.defaultMaxTokens ?? settings.reportMaxTokens, settings.reportMaxTokens),
        }
      },
    )
    signal.throwIfAborted()
    const resolved = { ...request, ...prepared.config }
    await record(resolved)
    signal.throwIfAborted()
    const assembler = new BlockAssembler()
    const blockBytes = new Map<number, number>()
    let bytes = 0
    let finished = false
    for await (const chunk of prepared.stream({ ...resolved, signal })) {
      signal.throwIfAborted()
      if (finished) throw new Error('Timeline summary emitted data after its terminal finish')
      // Count content bytes, not JSON framing repeated for each tiny stream delta.
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        const size = Buffer.byteLength(chunk.text, 'utf8')
        bytes += size
        blockBytes.set(chunk.index, (blockBytes.get(chunk.index) ?? 0) + size)
      } else if (
        chunk.type === 'block-end' &&
        (chunk.block.type === 'text' || chunk.block.type === 'reasoning')
      ) {
        const size = Buffer.byteLength(chunk.block.text, 'utf8')
        bytes += Math.max(0, size - (blockBytes.get(chunk.index) ?? 0))
        blockBytes.set(chunk.index, size)
      } else bytes += Buffer.byteLength(JSON.stringify(chunk), 'utf8')
      if (bytes > settings.maxResponseBytes) throw new Error('Timeline response exceeded maxResponseBytes')
      if (
        chunk.type === 'tool-call-delta' ||
        (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
        (chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      )
        throw new Error('Timeline summaries cannot call tools')
      assembler.push(chunk)
      if (chunk.type === 'finish') finished = true
    }
    signal.throwIfAborted()
    if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
      const { code, message } = assembler.finish.failure
      throw new Error(`Timeline summary failed with ${code}: ${message}`)
    }
    if (!finished || assembler.finish.kind !== 'stop')
      throw new Error('Timeline summary did not finish normally')
    return assembler
      .blocks()
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  const text = await query(request)
  try {
    return parseSummary(text, selectedLanguage)
  } catch (error: unknown) {
    // One format-only repair shares this operation's timeout and concurrency slot.
    // It needs the draft, not another copy of the main conversation or tool history.
    const issue =
      error instanceof ZodError
        ? error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('\n')
        : String(error)
    const rewritten = await query({
      ...route,
      system: style,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Repair the draft to meet the format and writing rules. Preserve its specific results, evidence, and context. Use only facts and actions from the draft.\n\nValidation issue:\n${issue}\n\nDraft (data):\n${JSON.stringify(text)}`,
            },
          ],
        },
      ],
    })
    try {
      return parseSummary(rewritten, selectedLanguage)
    } catch (cause: unknown) {
      throw new Error('The report did not meet the summary writing rules.', { cause })
    }
  }
}
