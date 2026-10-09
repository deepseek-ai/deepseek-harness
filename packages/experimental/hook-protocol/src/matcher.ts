/**
 * Matching and command-group selection shared by both hook dialects. Claude treats alphanumeric/underscore/
 * pipe patterns as literal alternatives and other patterns as regex; Codex
 * treats every non-empty pattern as an unanchored regex. Missing, empty, and
 * `*` match all. Runtime matching contains invalid regexes as non-matches;
 * config parsers use {@link matcherDiagnostic} to reject them with a diagnostic.
 * @module @deepseek-ai/dsh-hook-protocol/matcher
 */

import type { MatcherGroup, MatcherMode } from './types.ts'

/** True for an absent / empty / `'*'` pattern — the match-all sentinels. */
function isMatchAll(matcher: string | undefined): boolean {
  return matcher === undefined || matcher === '' || matcher === '*'
}

/** A Claude-literal pattern is purely word chars + `|` (the regex-vs-literal discriminator). */
const CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/

/** Compile an unanchored matcher regex; invalid patterns return `undefined`. */
function compileRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch (_syntaxError) {
    // RegExp construction is the try's only operation, so malformed pattern
    // syntax is the only expected failure.
    return undefined
  }
}

/**
 * Validate one matcher before a bridge accepts its config group.
 * @param matcher - configured pattern; match-all sentinels are valid.
 * @param mode - dialect deciding whether a word-and-pipe pattern is literal.
 * @returns `undefined` for a valid matcher, otherwise a stable diagnostic.
 */
export function matcherDiagnostic(matcher: string | undefined, mode: MatcherMode): string | undefined {
  if (isMatchAll(matcher)) return undefined
  const pattern = matcher as string
  if (mode === 'claude-code' && CLAUDE_LITERAL.test(pattern)) return undefined
  return compileRegex(pattern) === undefined
    ? `invalid ${mode} regex matcher ${JSON.stringify(pattern)}`
    : undefined
}

/**
 * Whether `matcher` selects `query` under the given dialect. Claude literal
 * patterns exact-match pipe-separated alternatives; all other patterns are
 * unanchored regexes. Invalid regexes return `false` rather than throwing;
 * bridge config parsers surface them through {@link matcherDiagnostic} before use.
 * @param matcher - the configured pattern; absent/empty/`'*'` are the match-all sentinels.
 * @param query - the candidate value (a tool name, a session source, …).
 * @param mode - the dialect deciding literal-vs-regex interpretation of the pattern.
 * @returns `true` when the pattern selects the query; `false` on a non-match or an invalid
 *   regex.
 */
export function matchesMatcher(matcher: string | undefined, query: string, mode: MatcherMode): boolean {
  if (isMatchAll(matcher)) return true
  // matcher is a non-empty string past the match-all guard.
  const pattern = matcher as string
  if (mode === 'claude-code' && CLAUDE_LITERAL.test(pattern)) {
    return pattern.split('|').includes(query)
  }
  return compileRegex(pattern)?.test(query) ?? false
}

/**
 * Select configured groups that have command hooks and match the event subject.
 * @param groups - groups for one hook point; absent points select no groups.
 * @param query - the event's matcher subject.
 * @param mode - dialect controlling literal or regex matching.
 * @returns Selected groups in config order, retaining their original references.
 */
export function selectHookGroups(
  groups: readonly MatcherGroup[] | undefined,
  query: string,
  mode: MatcherMode,
): MatcherGroup[] {
  return (groups ?? []).filter(group => group.hooks.length > 0 && matchesMatcher(group.matcher, query, mode))
}
