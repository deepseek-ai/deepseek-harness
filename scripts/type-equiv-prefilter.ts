/** Text prefilter that lets `verify-type-equiv` skip Markdown parsing for documents without a source-equivalence fence. */

/**
 * Whether `source` can contain a fence whose parsed info string is a
 * source-equivalence form; other documents skip Markdown parsing. Each such
 * info string contains `type-equiv` or `public-api`, and it is the parsed rest
 * of one opening fence line, which contains three backticks or tildes. Parsing
 * changes that text only by decoding backslash escapes and character
 * references, so an opening line without `\` or `&` contains the word
 * literally, and a fence line with either character keeps the document:
 * `ts type&#45;equiv` and `ts type\-equiv` both parse as `ts type-equiv`.
 * @param source - Markdown document text.
 * @returns `false` only when no fence in `source` can parse to a `type-equiv` or `public-api` info string.
 */
export function mayContainEquivFence(source: string): boolean {
  if (source.includes('type-equiv') || source.includes('public-api')) return true
  return source.split('\n').some(line =>
    (line.includes('```') || line.includes('~~~')) && (line.includes('&') || line.includes('\\')))
}
