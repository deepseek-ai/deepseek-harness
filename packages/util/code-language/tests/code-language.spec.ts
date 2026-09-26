import { describe, expect, it } from 'vitest'
import { CODE_HIGHLIGHT_EXTENSIONS, languageForPath, readLangHintForPath } from '../src/index.ts'

describe('languageForPath', () => {
  it.each([
    // Windows-facing script and shell extensions.
    ['build.bat', 'bat'], ['build.cmd', 'bat'], ['deploy.ps1', 'powershell'],
    ['module.psm1', 'powershell'], ['data.psd1', 'powershell'], ['config.fish', 'fish'],
    // Config, data, and text extensions.
    ['app.properties', 'ini'], ['app.conf', 'ini'], ['app.cfg', 'ini'],
    ['.env', 'dotenv'], ['server.log', 'log'],
    ['change.diff', 'diff'], ['fix.patch', 'diff'], ['api.http', 'http'],
    ['notebook.ipynb', 'json'], ['table.csv', 'csv'],
    // Documentation and markup extensions.
    ['guide.rst', 'rst'], ['paper.tex', 'latex'], ['style.sty', 'latex'],
    ['doc.cls', 'latex'], ['refs.bib', 'bibtex'], ['Info.plist', 'xml'],
    ['logo.svg', 'xml'], ['manual.adoc', 'asciidoc'],
    // Language extensions.
    ['analysis.r', 'r'], ['model.jl', 'julia'], ['main.dart', 'dart'],
    ['Main.scala', 'scala'], ['core.clj', 'clojure'], ['ui.cljs', 'clojure'],
    ['data.edn', 'clojure'], ['app.erl', 'erlang'], ['app.hrl', 'erlang'],
    ['app.ex', 'elixir'], ['app.exs', 'elixir'], ['Main.hs', 'haskell'],
    ['Types.fs', 'fsharp'], ['Types.fsi', 'fsharp'], ['script.fsx', 'fsharp'],
    ['Form.vb', 'vb'], ['script.pl', 'perl'], ['Module.pm', 'perl'],
    ['top.v', 'verilog'], ['top.sv', 'system-verilog'], ['defs.svh', 'system-verilog'],
    ['schema.graphql', 'graphql'], ['query.gql', 'graphql'], ['message.proto', 'proto'],
    ['main.tf', 'hcl'], ['terraform.tfvars', 'hcl'], ['stack.hcl', 'hcl'], ['build.groovy', 'groovy'],
    ['flake.nix', 'nix'], ['App.vue', 'vue'], ['App.svelte', 'svelte'],
    ['Makefile', undefined], ['build.mk', 'make'], ['CMakeLists.cmake', 'cmake'],
    ['build.gradle', 'groovy'],
  ])('resolves %s to %s', (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })

  it('resolves the extensions the preview and read tables already agreed on', () => {
    expect(languageForPath('src/a.ts')).toBe('typescript')
    expect(languageForPath('src/a.TSX')).toBe('typescript')
    expect(languageForPath('/abs/module.mjs')).toBe('javascript')
    expect(languageForPath('conf.yml')).toBe('yaml')
    expect(languageForPath('README.md')).toBe('markdown')
    expect(languageForPath('C:\\src\\main.rs')).toBe('rust')
  })

  it('resolves every suffix the preview registry declares beyond the persisted read hints', () => {
    for (const extension of ['jsonl', 'ndjson', 'pyw', 'pyi', 'rake', 'gemspec', 'hh', 'hxx', 'kts', 'xhtml', 'xsd', 'xsl', 'xslt']) {
      expect(languageForPath(`file.${extension}`), extension).toBeDefined()
    }
  })

  it('is case-insensitive and accepts Windows separators', () => {
    expect(languageForPath('C:\\path\\X.PS1')).toBe('powershell')
    expect(languageForPath('C:\\Proj\\Build.CMD')).toBe('bat')
    expect(languageForPath('dir\\sub\\Main.SCALA')).toBe('scala')
  })

  it('reads the suffix after the last path segment and last dot', () => {
    expect(languageForPath('a.py.bak')).toBeUndefined()
    expect(languageForPath('archive.tar.gz')).toBeUndefined()
    expect(languageForPath('/dir.py/plain')).toBeUndefined()
    expect(languageForPath('dir.ts/README')).toBeUndefined()
  })

  it('returns undefined for a dotfile, an extensionless name, a trailing dot, and an unknown suffix', () => {
    expect(languageForPath('.gitignore')).toBeUndefined()
    expect(languageForPath('/etc/hosts')).toBeUndefined()
    expect(languageForPath('trailingdot.')).toBeUndefined()
    expect(languageForPath('data.unknownext')).toBeUndefined()
  })

  it('returns undefined for a filename whose extension is an Object.prototype key', () => {
    expect(languageForPath('foo.constructor')).toBeUndefined()
    expect(languageForPath('foo.__proto__')).toBeUndefined()
    expect(languageForPath('foo.toString')).toBeUndefined()
    expect(languageForPath('foo.hasOwnProperty')).toBeUndefined()
  })

  it('leaves certificate and lock extensions unlisted', () => {
    for (const extension of ['pem', 'crt', 'key', 'cer', 'lock']) {
      expect(languageForPath(`secret.${extension}`), extension).toBeUndefined()
    }
  })

  it('leaves TSV unlisted because the highlighter has no TSV grammar', () => {
    expect(languageForPath('table.tsv')).toBeUndefined()
  })
})

describe('readLangHintForPath', () => {
  it('keeps the read card short hints recorded sessions already hold', () => {
    expect(readLangHintForPath('src/a.ts')).toBe('ts')
    expect(readLangHintForPath('src/a.tsx')).toBe('tsx')
    expect(readLangHintForPath('src/a.mts')).toBe('ts')
    expect(readLangHintForPath('src/a.cts')).toBe('ts')
    expect(readLangHintForPath('src/a.js')).toBe('js')
    expect(readLangHintForPath('src/a.jsx')).toBe('jsx')
    expect(readLangHintForPath('src/a.mjs')).toBe('js')
    expect(readLangHintForPath('src/a.cjs')).toBe('js')
    expect(readLangHintForPath('src/a.jsonc')).toBe('json')
    expect(readLangHintForPath('src/a.cc')).toBe('cpp')
    expect(readLangHintForPath('src/a.hpp')).toBe('cpp')
    expect(readLangHintForPath('src/a.sh')).toBe('sh')
    expect(readLangHintForPath('src/a.kt')).toBe('kotlin')
    expect(readLangHintForPath('README.md')).toBe('md')
    expect(readLangHintForPath('README.markdown')).toBe('md')
    expect(readLangHintForPath('page.htm')).toBe('html')
  })

  it('uses the language short id for a suffix with no persisted value', () => {
    expect(readLangHintForPath('build.ps1')).toBe('ps1')
    expect(readLangHintForPath('table.csv')).toBe('csv')
    expect(readLangHintForPath('.env')).toBe('env')
    expect(readLangHintForPath('infra.tf')).toBe('tf')
    expect(readLangHintForPath('paper.tex')).toBe('tex')
    expect(readLangHintForPath('server.log')).toBe('log')
    expect(readLangHintForPath('message.proto')).toBe('proto')
    // `.hcl`/`.tf`/`.tfvars` and `.gradle`/`.groovy` keep the label their own
    // suffix names, so a Nomad `.hcl` file is never labelled `tf`.
    expect(readLangHintForPath('nomad.hcl')).toBe('hcl')
    expect(readLangHintForPath('main.tf')).toBe('tf')
    expect(readLangHintForPath('terraform.tfvars')).toBe('tfvars')
    expect(readLangHintForPath('build.gradle')).toBe('gradle')
    expect(readLangHintForPath('build.groovy')).toBe('groovy')
  })

  // The short id each canonical language persists. Transcribed rather than
  // imported so this test fails when a canonical grammar id is put back into the
  // persisted value, which reading the implementation's own table would not catch.
  const SHORT_BY_LANGUAGE: Readonly<Record<string, string>> = {
    typescript: 'ts', javascript: 'js', shellscript: 'sh', fish: 'fish', json: 'json', csv: 'csv',
    python: 'py', ruby: 'rb', go: 'go', rust: 'rs', java: 'java', c: 'c', cpp: 'cpp',
    csharp: 'cs', kotlin: 'kotlin', swift: 'swift', php: 'php', yaml: 'yaml',
    toml: 'toml', ini: 'ini', dotenv: 'env', log: 'log', diff: 'diff', http: 'http',
    markdown: 'md', mdx: 'mdx', rst: 'rst', latex: 'tex', bibtex: 'bib',
    asciidoc: 'adoc', html: 'html', css: 'css', scss: 'scss', less: 'less', sql: 'sql',
    xml: 'xml', lua: 'lua', bat: 'bat', powershell: 'ps1', r: 'r', julia: 'jl',
    dart: 'dart', scala: 'scala', clojure: 'clj', erlang: 'erl', elixir: 'ex',
    haskell: 'hs', fsharp: 'fs', vb: 'vb', perl: 'pl', verilog: 'v',
    'system-verilog': 'sv', graphql: 'graphql', proto: 'proto', hcl: 'hcl', nix: 'nix',
    vue: 'vue', svelte: 'svelte', make: 'make', cmake: 'cmake', groovy: 'groovy',
  }

  it('persists a short id for every suffix', () => {
    // The persisted `lang` is the language's short name, plus the suffixes whose
    // own name is the better label. These languages' short names happen to equal
    // their grammar ids (`kotlin`, `swift`, `yaml`), so a result outside both
    // sets means a canonical id leaked back in for a language that has a
    // distinct short name (`powershell`, `dotenv`, `latex`, `hcl`).
    const allowed = new Set([...Object.values(SHORT_BY_LANGUAGE), 'tsx', 'jsx', 'tf', 'tfvars', 'gradle'])
    for (const extension of CODE_HIGHLIGHT_EXTENSIONS) {
      const hint = readLangHintForPath(`file.${extension}`)
      expect(hint, extension).toBeDefined()
      expect(allowed.has(hint ?? ''), extension).toBe(true)
    }
  })

  it('returns undefined exactly when the shared table does not recognize the suffix', () => {
    for (const path of ['.gitignore', '/etc/hosts', 'trailingdot.', 'data.unknownext', 'foo.constructor']) {
      expect(readLangHintForPath(path), path).toBeUndefined()
    }
  })
})

describe('CODE_HIGHLIGHT_EXTENSIONS', () => {
  it('lists every recognized suffix exactly once', () => {
    expect(new Set(CODE_HIGHLIGHT_EXTENSIONS).size).toBe(CODE_HIGHLIGHT_EXTENSIONS.length)
    expect(CODE_HIGHLIGHT_EXTENSIONS.length).toBeGreaterThan(100)
  })

  it('resolves each listed suffix back to a language', () => {
    for (const extension of CODE_HIGHLIGHT_EXTENSIONS) {
      expect(languageForPath(`file.${extension}`), extension).toBeDefined()
    }
  })
})
