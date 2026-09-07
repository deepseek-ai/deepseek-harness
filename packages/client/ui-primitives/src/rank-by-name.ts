/**
 * Shared ranking for `/` menu candidates: the query must be a
 * case-insensitive ordered subsequence of the candidate name. Prefix hits
 * rank first, then the strongest alignment score, then the source order of
 * the input. Decision record:
 * .agents/notes/archived/feature/2026-08-04-web-slash-command-fuzzy-discovery.md
 */

/** One match with its stable source position. */
interface Ranked<T> {
  readonly item: T
  readonly index: number
  readonly prefix: boolean
  readonly score: number
}

/** Extra weight for name starts and separator boundaries. */
function boundaryBonus(name: string, index: number): number {
  return index === 0 || name.charAt(index - 1) === '-' || name.charAt(index - 1) === '_' ? 8 : 0
}

/**
 * Score the strongest ordered-subsequence alignment in O(name × query).
 * Boundary and adjacent matches earn weight; skipped and leading characters
 * cost weight. Undefined when the query is not a subsequence of the name.
 */
function alignmentScore(name: string, query: string): number | undefined {
  if (query.length > name.length) return undefined
  const noMatch = Number.NEGATIVE_INFINITY
  let previous = Array<number>(name.length).fill(noMatch)
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) === query.charAt(0)) previous[index] = 1 + boundaryBonus(name, index) - index
  }
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = Array<number>(name.length).fill(noMatch)
    // Sweep the previous row once: `left` is its score one character back
    // (the adjacent continuation), `leftLeft` two back (the earliest gapped one).
    let left = noMatch
    let leftLeft = noMatch
    let bestGapped = noMatch
    for (const [index, prior] of previous.entries()) {
      if (leftLeft !== noMatch) bestGapped = Math.max(bestGapped, leftLeft + index - 2)
      if (name.charAt(index) === query.charAt(queryIndex)) {
        const bonus = 1 + boundaryBonus(name, index)
        let score = noMatch
        if (left !== noMatch) score = left + bonus + 4
        if (bestGapped !== noMatch) score = Math.max(score, bestGapped + bonus + 1 - index)
        current[index] = score
      }
      leftLeft = left
      left = prior
    }
    previous = current
  }
  let best = noMatch
  for (const score of previous) best = Math.max(best, score)
  return best === noMatch ? undefined : best
}

/**
 * Rank named items by a menu query.
 * @param items - candidates in source order (a host catalog, then client contributions).
 * @param rawQuery - the text typed after the trigger, matched case-insensitively.
 * @returns the matching items: prefix hits first, then by alignment score,
 * then in source order. The input list itself for an empty query.
 */
export function rankByName<T extends { readonly name: string }>(items: readonly T[], rawQuery: string): readonly T[] {
  const query = rawQuery.toLowerCase()
  if (query === '') return items
  const ranked: Ranked<T>[] = []
  items.forEach((item, index) => {
    const name = item.name.toLowerCase()
    const score = alignmentScore(name, query)
    if (score !== undefined) ranked.push({ item, index, prefix: name.startsWith(query), score })
  })
  ranked.sort((left, right) =>
    Number(right.prefix) - Number(left.prefix) || right.score - left.score || left.index - right.index)
  return ranked.map(match => match.item)
}
