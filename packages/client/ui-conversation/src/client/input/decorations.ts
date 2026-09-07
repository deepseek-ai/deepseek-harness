/**
 * Plain-text reference scan (the plain-text-reference decision;
 * see .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
 * a `/name` or `@name` token whose name is on the trigger's lexicon, and
 * syntax-recognizable `@dir/` folder tokens. Pure derivation — the editor's
 * text-ref entity transform consumes these ranges; editing the text out of
 * match shape simply drops the range next scan.
 */

/**
 * One plain-text reference range (the plain-text-reference decision;
 * see .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
 * a `/name` or `@name` token
 * whose name is on the trigger's lexicon. Pure derivation — editing the text
 * out of match shape simply drops the range next scan.
 */
export interface TextRefRange {
  readonly start: number
  readonly end: number
  readonly trigger: '/' | '@'
}

/** Token matcher: a trigger char at line start or after whitespace, then a word-ish name (never crosses \n). */
const TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g
const FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g
/**
 * What may follow a `/name` token: whitespace or the draft end, the boundary
 * the host skill gesture (`dsh-tool-skill`) requires, so `/nfs-hg/xxx`,
 * `/plan.md`, and `/plan。` are prose, never a reference.
 */
const SLASH_TOKEN_END_RE = /^(?:\s|$)/

/**
 * Scan the draft for plain-text reference tokens against the hot lexicons.
 * Word-boundary discipline: the trigger must sit at the draft
 * start or after whitespace ('x/name' never matches); the name must be an
 * exact lexicon member; a `/name` token must end at whitespace or the draft
 * end ('/name/x' is a path, '/name。' is prose).
 * @param draft - draft text.
 * @param lexicon - per-trigger name lists (a missing trigger scans nothing).
 * @returns matched ranges in draft order.
 */
export function scanTextRefs(
  draft: string, lexicon: ReadonlyMap<'/' | '@', readonly string[]>,
): TextRefRange[] {
  if (draft === '') return []
  const out: TextRefRange[] = []
  if (lexicon.size > 0) {
    TEXT_REF_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TEXT_REF_RE.exec(draft)) !== null) {
      const trigger = m[2] as '/' | '@'
      const name = m[3] ?? ''
      if (trigger === '/' && !SLASH_TOKEN_END_RE.test(draft.slice(m.index + m[0].length))) continue
      if (lexicon.get(trigger)?.includes(name)) {
        const start = m.index + (m[1]?.length ?? 0)
        out.push({ start, end: start + 1 + name.length, trigger })
      }
    }
  }
  FOLDER_REF_RE.lastIndex = 0
  let folder: RegExpExecArray | null
  while ((folder = FOLDER_REF_RE.exec(draft)) !== null) {
    const token = folder[2] ?? ''
    const start = folder.index + (folder[1]?.length ?? 0)
    const end = start + token.length
    if (!out.some(range => range.start < end && range.end > start)) {
      out.push({ start, end, trigger: '@' })
    }
  }
  return out.sort((left, right) => left.start - right.start)
}
