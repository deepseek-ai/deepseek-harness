/** File suffixes mapped to grammars already supported by the shared CodeBlock. */
const languageExtensions: Readonly<Record<string, readonly string[]>> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  shellscript: ['sh', 'bash', 'zsh'],
  json: ['json', 'jsonc', 'jsonl', 'ndjson'],
  python: ['py', 'pyw', 'pyi'],
  ruby: ['rb', 'rake', 'gemspec'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
  csharp: ['cs'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  php: ['php'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  ini: ['ini'],
  markdown: ['md', 'markdown'],
  mdx: ['mdx'],
  html: ['html', 'htm', 'xhtml'],
  css: ['css'],
  scss: ['scss'],
  less: ['less'],
  sql: ['sql'],
  xml: ['xml', 'xsd', 'xsl', 'xslt'],
  lua: ['lua'],
}

const languages = new Map(Object.entries(languageExtensions)
  .flatMap(([language, extensions]) => extensions.map(extension => [extension, language] as const)))

/** Recognized suffixes shared by renderer selection and language hints. */
export const CODE_EXTENSIONS: readonly string[] = [...languages.keys()]

/**
 * Select the shared highlighter's grammar for a filename.
 * @param path - decoded source filename or path.
 * @returns a supported grammar hint, or undefined for other suffixes.
 */
export function languageForPath(path: string): string | undefined {
  const extension = /\.([^./]+)$/u.exec(path.replaceAll('\\', '/'))?.[1]?.toLowerCase()
  return extension === undefined ? undefined : languages.get(extension)
}
