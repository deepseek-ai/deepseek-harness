/** Identify checked generated schema lines in canonical historical Session format references. */

/**
 * Locate the generated schema content protected by one exact marker pair.
 * @param file - repository-relative path with slash separators.
 * @param source - complete Markdown source, including authored prose and markers.
 * @returns the zero-based, end-exclusive content line range, or undefined for other paths or malformed markers.
 */
export function historicalSchemaRegion(file: string, source: string): readonly [number, number] | undefined {
  if (!/^docs\/persistence-changes\/historical-formats\/v(?:0|[1-9]\d*)(?:\.zh)?\.md$/u.test(file)) return undefined
  if (source.match(/<!--\s*persistence-format-schema\b/giu)?.length !== 2) return undefined
  const lines = source.split(/\r?\n/u)
  const start = lines.indexOf('<!-- persistence-format-schema:start -->')
  const end = lines.indexOf('<!-- persistence-format-schema:end -->')
  // The format gate verifies this content against the frozen historical schema inventory.
  return start >= 0 && end > start ? [start + 1, end] : undefined
}
