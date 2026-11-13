// Report roles and exclusion rules adapted from kermanx/dsh-progress-check (MIT).
import { z } from 'zod'
import type { OutputLanguage } from './policy.ts'
import type { Summary } from './records.ts'

/** Fixed writing constraints also apply when a user supplies a custom emphasis prompt. */
export const reportStyle = `Write a report only. Use ASD-STE100 clarity principles in the required language: plain words, active voice, and self-contained sentences. Name the affected capability or problem, the result, and its impact on the goal. Distinguish verified outcomes, findings from inspection, claims, and plans. Use only supported facts.
State what the work found or changed. For example, write "Import can erase saved notes without confirmation." Give counts only when they answer the user's question, and explain what they measure. Use names a reader can understand without the conversation. Omit internal identifiers, jargon, metaphors, and irrelevant implementation details.
Return only JSON: {"progress":["<result and impact>","<evidence>","<remaining gap or decided next step>"],"uncertainties":[],"userActions":[]}. Use 1–4 progress items, normally 3–4 when supported. Make the first item a standalone preview. Use later items for evidence, limits, or a decided next step. Preserve distinct findings in rollups and merge repeated results.
Each item is plain text on one line, at most 320 characters, or 160 for Chinese or Japanese. List up to two evidenced unresolved decisions in uncertainties. Label recommendations as proposals. List up to two useful actions the user can take in parallel now in userActions. Omit routine approvals and the agent's own work. Use empty arrays for groups with no applicable items.`

/**
 * Validate the new compact output without rejecting older, longer durable reports on replay.
 * @param text - the text to parse.
 * @param language - configured Timeline language.
 * @returns the validated progress, questions, and actions.
 */
export function parseSummary(text: string, language: OutputLanguage): Summary {
  const compact = language === 'zh-CN' || language === 'ja'
  const line = z
    .string()
    .trim()
    .min(1)
    .max(compact ? 160 : 320)
    .refine(
      value => !value.includes('\n') && !value.includes('`'),
      'Use plain text without newlines or code',
    )
  return z
    .object({
      progress: line.array().min(1).max(4),
      uncertainties: line.array().max(2),
      userActions: line.array().max(2),
    })
    .strict()
    .parse(JSON.parse(text.replace(/^\s*```(?:json)?\s*\n/u, '').replace(/\n```\s*$/u, '')))
}
