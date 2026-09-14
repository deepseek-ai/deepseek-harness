/** Code and configuration categories with embedded full-color glyphs. */
export const CODE_FILE_TYPES = [
  'angular',
  'c',
  'clojure',
  'cmake',
  'cpp',
  'csharp',
  'css',
  'dart',
  'docker',
  'elixir',
  'env',
  'erlang',
  'flutter',
  'git',
  'go',
  'graphql',
  'haskell',
  'ini',
  'java',
  'javascript',
  'json',
  'kotlin',
  'lua',
  'makefile',
  'node',
  'objective-c',
  'perl',
  'php',
  'powershell',
  'protobuf',
  'python',
  'r',
  'react',
  'ruby',
  'rust',
  'scala',
  'shell',
  'solidity',
  'sql',
  'svelte',
  'swift',
  'toml',
  'typescript',
  'vue',
  'wasm',
  'xml',
  'yaml',
  'zig',
] as const

/** A code or configuration file category with its own full-color square glyph. */
export type CodeFileType = typeof CODE_FILE_TYPES[number]

/** Optional project files used by context-sensitive code-icon rules. */
export interface FileTypeProjectContext {
  /** Text content keyed by project-relative or basename path. */
  readonly files: Readonly<Record<string, string | undefined>>
}

const CODE_FILE_TYPE_SET = new Set<string>(CODE_FILE_TYPES)

const FILE_NAME_TYPES: Readonly<Record<string, CodeFileType>> = {
  '.bash_profile': 'shell',
  '.bashrc': 'shell',
  '.env': 'env',
  '.gitattributes': 'git',
  '.gitconfig': 'git',
  '.gitignore': 'git',
  '.gitmodules': 'git',
  '.mailmap': 'git',
  '.profile': 'shell',
  '.zprofile': 'shell',
  '.zshrc': 'shell',
  'bsdmakefile': 'makefile',
  'cmakelists.txt': 'cmake',
  'commit_editmsg': 'git',
  'compose.yaml': 'docker',
  'compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'docker-compose.yml': 'docker',
  'dockerfile': 'docker',
  'gemfile': 'ruby',
  'gnumakefile': 'makefile',
  'guardfile': 'ruby',
  'makefile': 'makefile',
  'npm-shrinkwrap.json': 'node',
  'package-lock.json': 'node',
  'package.json': 'node',
  'podfile': 'ruby',
  'rakefile': 'ruby',
}

const FILE_NAME_PREFIX_TYPES: readonly (readonly [string, CodeFileType])[] = [
  ['dockerfile.', 'docker'],
  ['.env.', 'env'],
]

const FILE_NAME_SUFFIX_TYPES: readonly (readonly [string, CodeFileType])[] = [
  ['.component.ts', 'angular'],
  ['.component.html', 'angular'],
  ['.directive.ts', 'angular'],
  ['.service.ts', 'angular'],
  ['.module.ts', 'angular'],
  ['.pipe.ts', 'angular'],
  ['.guard.ts', 'angular'],
  ['.interceptor.ts', 'angular'],
  ['.dockerfile', 'docker'],
]

const EXTENSION_TYPES: Readonly<Record<string, CodeFileType>> = {
  'bash': 'shell',
  'c': 'c',
  'c++': 'cpp',
  'cc': 'cpp',
  'cfg': 'ini',
  'cjs': 'javascript',
  'clj': 'clojure',
  'cljc': 'clojure',
  'cljs': 'clojure',
  'cmake': 'cmake',
  'cpp': 'cpp',
  'cs': 'csharp',
  'csh': 'shell',
  'css': 'css',
  'csx': 'csharp',
  'cts': 'typescript',
  'cxx': 'cpp',
  'dart': 'dart',
  'dtd': 'xml',
  'edn': 'clojure',
  'env': 'env',
  'erl': 'erlang',
  'es6': 'javascript',
  'escript': 'erlang',
  'ex': 'elixir',
  'exs': 'elixir',
  'fish': 'shell',
  'gemspec': 'ruby',
  'go': 'go',
  'gql': 'graphql',
  'graphql': 'graphql',
  'h': 'c',
  'h++': 'cpp',
  'hh': 'cpp',
  'hpp': 'cpp',
  'hrl': 'erlang',
  'hs': 'haskell',
  'hxx': 'cpp',
  'ini': 'ini',
  'ipp': 'cpp',
  'java': 'java',
  'js': 'javascript',
  'json': 'json',
  'json5': 'json',
  'jsonc': 'json',
  'jsx': 'react',
  'ksh': 'shell',
  'kt': 'kotlin',
  'kts': 'kotlin',
  'lhs': 'haskell',
  'lua': 'lua',
  'm': 'objective-c',
  'mak': 'makefile',
  'mjs': 'javascript',
  'mk': 'makefile',
  'mm': 'objective-c',
  'mts': 'typescript',
  'node': 'node',
  'pch': 'objective-c',
  'php': 'php',
  'php3': 'php',
  'php4': 'php',
  'php5': 'php',
  'phps': 'php',
  'phtml': 'php',
  'pl': 'perl',
  'plist': 'xml',
  'pm': 'perl',
  'pod': 'perl',
  'proto': 'protobuf',
  'ps1': 'powershell',
  'psd1': 'powershell',
  'psm1': 'powershell',
  'py': 'python',
  'pyi': 'python',
  'pyw': 'python',
  'pyx': 'python',
  'r': 'r',
  'rake': 'ruby',
  'rb': 'ruby',
  'rmd': 'r',
  'rs': 'rust',
  'sc': 'scala',
  'scala': 'scala',
  'sh': 'shell',
  'sol': 'solidity',
  'sql': 'sql',
  'svelte': 'svelte',
  'swift': 'swift',
  't': 'perl',
  'tcsh': 'shell',
  'toml': 'toml',
  'tpp': 'cpp',
  'ts': 'typescript',
  'tsx': 'react',
  'vue': 'vue',
  'wasm': 'wasm',
  'wast': 'wasm',
  'wat': 'wasm',
  'xml': 'xml',
  'xsd': 'xml',
  'xsl': 'xml',
  'xslt': 'xml',
  'yaml': 'yaml',
  'yml': 'yaml',
  'zig': 'zig',
  'zsh': 'shell',
}

const LINK_CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'cts',
  'mts',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'astro',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'env',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'py',
  'pyi',
  'rb',
  'rs',
  'go',
  'java',
  'kt',
  'kts',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'cs',
  'php',
  'swift',
  'sql',
  'csv',
  'tsv',
  'proto',
  'graphql',
  'gql',
  'lua',
  'r',
  'pl',
  'scala',
  'clj',
  'cljs',
  'ex',
  'exs',
  'erl',
  'hs',
  'dart',
])

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * Test whether a resolved file type uses the full-color code-icon set.
 * @param type - Resolved file-type string.
 * @returns Whether the value is a detailed code-file type.
 */
export function isCodeFileType(type: string): type is CodeFileType {
  return CODE_FILE_TYPE_SET.has(type)
}

/**
 * Test whether an extension belonged to the established coarse LinkIcon code category.
 * @param extension - Extension without a leading dot.
 * @returns Whether clickable links keep the code glyph for this extension.
 */
export function isLinkCodeExtension(extension: string): boolean {
  return LINK_CODE_EXTENSIONS.has(extension.toLowerCase())
}

/**
 * Resolve the most specific code/configuration icon according to the supplied map priority.
 * @param name - Lowercase basename.
 * @param extension - Lowercase extension without the leading dot.
 * @param context - Optional project-file snapshot for context-sensitive matches.
 * @returns The detailed code type, or null when the traditional file classifier owns the path.
 */
export function classifyCodeFileType(
  name: string,
  extension: string,
  context?: FileTypeProjectContext,
): CodeFileType | null {
  const exact = FILE_NAME_TYPES[name]
  if (exact !== undefined) return exact
  for (const [prefix, type] of FILE_NAME_PREFIX_TYPES) {
    if (name.startsWith(prefix)) return type
  }
  for (const [suffix, type] of FILE_NAME_SUFFIX_TYPES) {
    if (name.endsWith(suffix)) return type
  }
  if (extension === 'dart' && context !== undefined) {
    const pubspec = Object.entries(context.files).find(([path]) => basename(path).toLowerCase() === 'pubspec.yaml')?.[1]
    if (pubspec?.includes('flutter:') === true) return 'flutter'
  }
  return EXTENSION_TYPES[extension] ?? null
}
