// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { languageForPath as sharedLanguageForPath, readLangHintForPath } from '@deepseek-ai/dsh-util-code-language'
import { CODE_HIGHLIGHT_EXTENSIONS, languageForPath, useCodeHighlighter } from '../src/code-highlighting.ts'
import { grammarForHint, supportsHighlighting } from '../src/markdown/highlight.ts'

afterEach(cleanup)

describe('code highlighting', () => {
  it.each([
    ['component.TSX', 'typescript'], ['module.mts', 'typescript'], ['module.cts', 'typescript'],
    ['client.jsx', 'javascript'], ['module.mjs', 'javascript'], ['module.cjs', 'javascript'],
    ['script.sh', 'shellscript'], ['script.zsh', 'shellscript'], ['data.jsonc', 'json'],
    ['events.jsonl', 'json'], ['model.pyi', 'python'], ['task.rake', 'ruby'],
    ['main.go', 'go'], ['main.rs', 'rust'], ['Main.java', 'java'], ['main.c', 'c'],
    ['header.h', 'c'], ['header.hpp', 'cpp'], ['main.cxx', 'cpp'], ['Main.cs', 'csharp'],
    ['build.kts', 'kotlin'], ['main.swift', 'swift'], ['index.php', 'php'],
    ['config.yml', 'yaml'], ['config.toml', 'toml'], ['config.ini', 'ini'],
    ['README.md', 'markdown'], ['page.mdx', 'mdx'], ['index.HTML', 'html'],
    ['index.htm', 'html'], ['style.css', 'css'], ['style.scss', 'scss'],
    ['style.less', 'less'], ['query.sql', 'sql'], ['schema.xsd', 'xml'], ['init.lua', 'lua'],
  ])('uses the existing %s grammar hint %s', (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })

  it.each([
    ['build.bat', 'bat'], ['build.cmd', 'bat'], ['deploy.ps1', 'powershell'],
    ['module.psm1', 'powershell'], ['config.fish', 'fish'], ['app.properties', 'ini'],
    ['app.conf', 'ini'], ['.env', 'dotenv'], ['server.log', 'log'],
    ['change.diff', 'diff'], ['fix.patch', 'diff'], ['api.http', 'http'], ['notebook.ipynb', 'json'],
    ['guide.rst', 'rst'], ['paper.tex', 'latex'], ['style.sty', 'latex'], ['doc.cls', 'latex'],
    ['refs.bib', 'bibtex'], ['Info.plist', 'xml'], ['logo.svg', 'xml'], ['manual.adoc', 'asciidoc'],
    ['analysis.r', 'r'], ['model.jl', 'julia'], ['main.dart', 'dart'], ['Main.scala', 'scala'],
    ['core.clj', 'clojure'], ['ui.cljs', 'clojure'], ['data.edn', 'clojure'], ['app.erl', 'erlang'],
    ['app.hrl', 'erlang'], ['app.ex', 'elixir'], ['app.exs', 'elixir'], ['Main.hs', 'haskell'],
    ['Types.fs', 'fsharp'], ['Types.fsi', 'fsharp'], ['Form.vb', 'vb'], ['script.pl', 'perl'],
    ['Module.pm', 'perl'], ['top.v', 'verilog'], ['top.sv', 'system-verilog'],
    ['defs.svh', 'system-verilog'], ['schema.graphql', 'graphql'], ['query.gql', 'graphql'],
    ['message.proto', 'proto'], ['main.tf', 'hcl'], ['terraform.tfvars', 'hcl'], ['stack.hcl', 'hcl'],
    ['flake.nix', 'nix'], ['App.vue', 'vue'], ['App.svelte', 'svelte'], ['build.mk', 'make'],
    ['CMakeLists.cmake', 'cmake'], ['build.gradle', 'groovy'],
  ])('uses the extended %s grammar hint %s', (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })

  it('resolves through the one shared extension table, never a local copy', () => {
    // A second canonical table re-introduced here fails this identity assertion
    // before it can drift from the shared extension table.
    expect(languageForPath).toBe(sharedLanguageForPath)
  })

  it("reaches one grammar from the shared canonical id and the read card's persisted hint", () => {
    // The read card persists short ids while this surface reads the canonical
    // table directly; both must select the same grammar, so a persisted hint can
    // never render differently from this surface's own selection. The identity
    // assertion above cannot cover that, because the two projections
    // intentionally differ.
    for (const extension of CODE_HIGHLIGHT_EXTENSIONS) {
      const path = `file.${extension}`
      const readHint = readLangHintForPath(path)
      expect(readHint, extension).toBeDefined()
      expect(grammarForHint(readHint), extension).toBe(grammarForHint(languageForPath(path)))
    }
  })

  it('keeps every registered suffix highlightable by the shared primitive', () => {
    expect(new Set(CODE_HIGHLIGHT_EXTENSIONS).size).toBe(CODE_HIGHLIGHT_EXTENSIONS.length)
    for (const extension of CODE_HIGHLIGHT_EXTENSIONS) {
      expect(supportsHighlighting(languageForPath(`file.${extension}`)), extension).toBe(true)
    }
  })

  it('uses the filename suffix for both path separators', () => {
    expect(languageForPath('/project/archive.old/source.d.ts')).toBe('typescript')
    expect(languageForPath('C:\\project\\source.CPP')).toBe('cpp')
  })

  it.each(['README', 'dir.ts/README', 'notes.txt', 'main.ts.backup', 'file.unknown', 'file.constructor', 'file.__proto__'])('does not claim %s', (path) => {
    expect(languageForPath(path)).toBeUndefined()
  })

  it('returns plain text for an absent language and refreshes after a lazy grammar loads', async () => {
    const plain = renderHook(() => useCodeHighlighter(undefined))
    expect(plain.result.current('plain')).toBeUndefined()

    const lazy = renderHook(() => useCodeHighlighter('lua'))
    const loading = lazy.result.current
    expect(loading('local answer = 42')).toBeUndefined()
    await waitFor(() => { expect(lazy.result.current).not.toBe(loading) })
    expect(lazy.result.current('local answer = 42')).not.toBeUndefined()
  })

  it.each(['powershell', 'system-verilog', 'bat'])('loads the %s grammar through the lazy path', async (language) => {
    const hook = renderHook(() => useCodeHighlighter(language))
    const initial = hook.result.current
    // Invoking the plain fallback starts the dynamic import; the callback
    // identity changes once the grammar registers and notifies subscribers.
    if (initial('sample') === undefined) {
      await waitFor(() => { expect(hook.result.current).not.toBe(initial) })
    }
    expect(hook.result.current('sample')).not.toBeUndefined()
  })
})
