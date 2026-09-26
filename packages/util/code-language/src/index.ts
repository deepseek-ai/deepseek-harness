/**
 * The single file-extension to syntax-highlighting language table shared by every
 * code surface: the Client's document Code preview and diff review, and the Host
 * read tool's persisted `lang` hint. Language ids are the grammar ids the Client
 * highlighter's alias table resolves, so a language returned here reaches
 * `highlightLines`/`highlightToHtml` unchanged; a filename outside the table, or
 * one naming a language the highlighter does not register, renders as plain text.
 * The read tool persists a short `lang` id, so {@link readLangHintForPath}
 * projects short ids over this table: a suffix keeps the value a recorded session
 * already holds, and every other suffix persists the language's short name —
 * which for `kotlin`, `swift`, `yaml`, `json`, and similar equals that
 * language's grammar id.
 * @module @deepseek-ai/dsh-util-code-language
 */

/**
 * Recognized extensions per canonical language id. Values are lowercase
 * extensions without the dot; the id names the grammar rather than a display
 * label. The set covers common source, config, script, data, and markup
 * extensions a line-numbered code view or preview benefits from highlighting; it
 * is deliberately not an exhaustive linguist registry. Extensions whose Shiki
 * grammar does not exist map to the nearest available grammar
 * (`properties` to `ini`, whose registration carries the `properties` alias) or
 * stay unlisted. Certificate and lock extensions (`pem`, `crt`, `key`, `cer`,
 * `lock`) stay unlisted. Preview registries order specialized viewers before
 * Code so CSV can default to Spreadsheet while retaining syntax highlighting.
 * `makefile` covers only the suffix
 * (`foo.makefile`); the extensionless `Makefile` name stays unlisted.
 */
const LANGUAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  shellscript: ['sh', 'bash', 'zsh'],
  fish: ['fish'],
  json: ['json', 'jsonc', 'jsonl', 'ndjson', 'ipynb'],
  csv: ['csv'],
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
  ini: ['ini', 'conf', 'cfg', 'properties'],
  dotenv: ['env'],
  log: ['log'],
  diff: ['diff', 'patch'],
  http: ['http'],
  markdown: ['md', 'markdown'],
  mdx: ['mdx'],
  rst: ['rst'],
  latex: ['tex', 'sty', 'cls'],
  bibtex: ['bib'],
  asciidoc: ['adoc'],
  html: ['html', 'htm', 'xhtml'],
  css: ['css'],
  scss: ['scss'],
  less: ['less'],
  sql: ['sql'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'svg'],
  lua: ['lua'],
  bat: ['bat', 'cmd'],
  powershell: ['ps1', 'psm1', 'psd1'],
  r: ['r'],
  julia: ['jl'],
  dart: ['dart'],
  scala: ['scala'],
  clojure: ['clj', 'cljs', 'edn'],
  erlang: ['erl', 'hrl'],
  elixir: ['ex', 'exs'],
  haskell: ['hs'],
  fsharp: ['fs', 'fsi', 'fsx'],
  vb: ['vb'],
  perl: ['pl', 'pm'],
  verilog: ['v'],
  'system-verilog': ['sv', 'svh'],
  graphql: ['graphql', 'gql'],
  proto: ['proto'],
  hcl: ['tf', 'tfvars', 'hcl'],
  nix: ['nix'],
  vue: ['vue'],
  svelte: ['svelte'],
  make: ['makefile', 'mk'],
  cmake: ['cmake'],
  groovy: ['gradle', 'groovy'],
}

/**
 * Lowercase extension to canonical language id. A Map, not an object: a filename
 * whose extension is an `Object.prototype` key (`foo.constructor`,
 * `foo.__proto__`) must miss instead of resolving the inherited member, which
 * would otherwise reach callers as a non-string language value.
 */
const LANGUAGES = new Map(Object.entries(LANGUAGE_EXTENSIONS)
  .flatMap(([language, extensions]) => extensions.map(extension => [extension, language] as const)))

/** Every recognized filename suffix, one entry each; a document-preview registry uses it to claim Code-rendered bodies. */
export const CODE_HIGHLIGHT_EXTENSIONS: readonly string[] = [...LANGUAGES.keys()]

/**
 * Persisted `lang` values a language-level short id cannot express, keyed by the
 * suffix that produced them. Everything else falls back to
 * {@link SHORT_BY_LANGUAGE}, so only a suffix whose own name is the better label
 * appears here. Each value is the exact string recorded sessions already hold
 * and must not change; the byte-level expectation for every suffix lives in the
 * read consumer's test.
 */
const READ_LANG_BY_EXTENSION = new Map<string, string>([
  // The two JSX flavors keep their own suffix; every other persisted value is
  // the language's short name, or an extension naming itself better than its
  // language does (`tf` rather than `hcl`, `gradle` rather than `groovy`).
  ['tsx', 'tsx'], ['jsx', 'jsx'],
  ['tf', 'tf'], ['tfvars', 'tfvars'], ['gradle', 'gradle'],
])

/**
 * The short `lang` id the read card persists, keyed by canonical language id.
 * Keys are exactly the languages in {@link LANGUAGE_EXTENSIONS}: where
 * {@link READ_LANG_BY_EXTENSION} does not already fix a suffix's value, this
 * table supplies the language's short name (`powershell` to `ps1`, `hcl` to
 * `tf`, `system-verilog` to `sv`) rather than the grammar id. Keys are canonical
 * ids, not untrusted extensions, so an object lookup cannot reach an
 * `Object.prototype` member the way the extension tables can.
 */
const SHORT_BY_LANGUAGE: Readonly<Record<string, string>> = {
  typescript: 'ts',
  javascript: 'js',
  shellscript: 'sh',
  fish: 'fish',
  json: 'json',
  csv: 'csv',
  python: 'py',
  ruby: 'rb',
  go: 'go',
  rust: 'rs',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  kotlin: 'kotlin',
  swift: 'swift',
  php: 'php',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  dotenv: 'env',
  log: 'log',
  diff: 'diff',
  http: 'http',
  markdown: 'md',
  mdx: 'mdx',
  rst: 'rst',
  latex: 'tex',
  bibtex: 'bib',
  asciidoc: 'adoc',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  xml: 'xml',
  lua: 'lua',
  bat: 'bat',
  powershell: 'ps1',
  r: 'r',
  julia: 'jl',
  dart: 'dart',
  scala: 'scala',
  clojure: 'clj',
  erlang: 'erl',
  elixir: 'ex',
  haskell: 'hs',
  fsharp: 'fs',
  vb: 'vb',
  perl: 'pl',
  verilog: 'v',
  'system-verilog': 'sv',
  graphql: 'graphql',
  proto: 'proto',
  hcl: 'hcl',
  nix: 'nix',
  vue: 'vue',
  svelte: 'svelte',
  make: 'make',
  cmake: 'cmake',
  groovy: 'groovy',
}

function extensionForPath(path: string): string | undefined {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? undefined : base.slice(dot + 1).toLowerCase()
}

/**
 * Derive the syntax-highlighting language from a filename or path, case
 * insensitively. The extension is the text after the last dot of the final path
 * segment; a leading dot is still the separator, so `.env` resolves to `dotenv`
 * while an unlisted dotfile (`.gitignore`) and an extensionless name return
 * `undefined`. Both path separators are recognized, so
 * `C:\\dir\\main.PS1` resolves like `dir/main.ps1`.
 * @param path - decoded filename or path.
 * @returns the canonical language id, or `undefined` for an unrecognized or absent suffix.
 */
export function languageForPath(path: string): string | undefined {
  const extension = extensionForPath(path)
  return extension === undefined ? undefined : LANGUAGES.get(extension)
}

/**
 * Derive the Host read card's persisted `lang` hint from a read path's
 * extension. The value is the language's short name; for some languages that name
 * is also the grammar id (`kotlin`, `swift`, `java`, `yaml`, `json`), and
 * {@link READ_LANG_BY_EXTENSION} overrides it where the suffix names itself
 * better (`tsx`, `tf`, `gradle`). A suffix a recorded session already holds keeps
 * its persisted value. An unrecognized suffix stays `undefined`, so the card
 * renders as plain text.
 * @param path - the model-facing path the read reported.
 * @returns the persisted language hint, or `undefined` when the extension maps to none.
 */
export function readLangHintForPath(path: string): string | undefined {
  const extension = extensionForPath(path)
  if (extension === undefined) return undefined
  const canonical = LANGUAGES.get(extension)
  return canonical === undefined ? undefined : READ_LANG_BY_EXTENSION.get(extension) ?? SHORT_BY_LANGUAGE[canonical]
}
