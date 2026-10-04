/** Source adapters evaluated in per-test VMs; npm fixtures are read-only and no browser globals are shared. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { imagesModule } from '../scripts/devtools/inputs.ts'
import {
  configureCodeMirrorBrowser,
  configureHostPerformanceSource,
  cssTextModule,
  restoreModuleUrls,
} from '../scripts/devtools/source.ts'

const timelinePath = 'panels/timeline/TimelinePanel.ts'
const frontend = new URL('../node_modules/chrome-devtools-frontend/front_end/', import.meta.url)
const nodeMode = '#isNode = Root.Runtime.Runtime.isNode();'
const nodeTarget = 'SDK.TargetManager.TargetManager.instance().targets().find(target => target.type() === SDK.Target.Type.NODE)'
const primaryTarget = 'SDK.TargetManager.TargetManager.instance().primaryPageTarget()'

function npmSource(path: string): string {
  return readFileSync(new URL(path, frontend), 'utf8')
}

function evaluateModule(source: string): Record<string, unknown> {
  const exports: Record<string, unknown> = {}
  // CommonJS emission evaluates these import-free generated modules without Node's experimental VM module flag.
  const emitted = ts.transpileModule(source, {
    fileName: 'generated.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  })
  expect(emitted.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error)).toEqual([])
  runInNewContext(emitted.outputText, { exports })
  return exports
}

describe('restoreModuleUrls', () => {
  it.each([
    'const answer = 42;\r\n',
    '// import.meta.url and import.meta.resolve("./icon.svg")\r\n',
    '/* import.meta.url\nimport.meta.resolve() */\n',
    'const message = "import.meta.url";\n',
    'const message = `import.meta.resolve("./icon.svg")`;\n',
    'const pattern = /import.meta.url/;\n',
    'const metadata = import.meta.env; const url = other.meta.url;\n',
  ])('preserves non-URL syntax byte-for-byte: %s', (source) => {
    expect(restoreModuleUrls(timelinePath, source)).toBe(source)
  })

  it.each([
    ['https://inspector.test/devtools_app.html', 'https://inspector.test/'],
    ['https://inspector.test/team/alice/inspector/devtools/devtools_app.html?ws=host#console',
      'https://inspector.test/team/alice/inspector/devtools/'],
    ['https://inspector.test/nested/devtools/', 'https://inspector.test/nested/devtools/'],
  ])('resolves window resources from document.baseURI %s', (baseURI, root) => {
    const source = `({
      module: import.meta.url,
      sibling: import.meta.resolve('./TimelineLoader.js?cache=1#loader'),
      image: new URL('../../Images/file name.svg', import.meta.url).href,
      absolute: import.meta.resolve('https://assets.test/icon.svg'),
    })`
    const result: unknown = runInNewContext(restoreModuleUrls(timelinePath, source), {
      URL, document: { baseURI },
    })
    expect(result).toEqual({
      module: `${root}panels/timeline/TimelinePanel.js`,
      sibling: `${root}panels/timeline/TimelineLoader.js?cache=1#loader`,
      image: `${root}Images/file%20name.svg`,
      absolute: 'https://assets.test/icon.svg',
    })
  })

  it.each([
    ['https://inspector.test/entrypoints/heap_snapshot_worker/heap_snapshot_worker.js', 'https://inspector.test/'],
    ['https://inspector.test/team/alice/devtools/entrypoints/heap_snapshot_worker/heap_snapshot_worker.js?worker=1#ready',
      'https://inspector.test/team/alice/devtools/'],
  ])('uses the frontend root two levels above the worker %s', (href, root) => {
    const source = '({module: import.meta.url, dependency: import.meta.resolve(\'./HeapSnapshot.js\')})'
    const result: unknown = runInNewContext(restoreModuleUrls('models/heap_snapshot/HeapSnapshotWorker.ts', source), {
      URL, self: { location: { href } },
    })
    expect(result).toEqual({
      module: `${root}models/heap_snapshot/HeapSnapshotWorker.js`,
      dependency: `${root}models/heap_snapshot/HeapSnapshot.js`,
    })
  })

  it('preserves surrounding strings and comments while rewriting multiple expressions', () => {
    const prefix = '// import.meta.resolve() stays a comment\r\nconst text = "import.meta.url";\r\n'
    const suffix = '\r\n// import.meta.url stays a comment\r\n'
    const source = prefix + '[text, import.meta.url, import.meta.resolve("./next.js")];' + suffix
    const result = restoreModuleUrls('core/common/example.js', source)
    expect(result.startsWith(prefix)).toBe(true)
    expect(result.endsWith(suffix)).toBe(true)
    expect(runInNewContext(result, { URL, document: { baseURI: 'https://inspector.test/devtools/app.html' } })).toEqual([
      'import.meta.url', 'https://inspector.test/devtools/core/common/example.js',
      'https://inspector.test/devtools/core/common/next.js',
    ])
  })

  it('evaluates a dynamic resolve argument once and accepts a trailing comma', () => {
    const requests: string[] = []
    const source = 'import.meta.resolve(resource(),)'
    const result: unknown = runInNewContext(restoreModuleUrls(timelinePath, source), {
      URL, document: { baseURI: 'https://inspector.test/sub/app.html' },
      resource: () => { requests.push('resource'); return './snapshot.json' },
    })
    expect(result).toBe('https://inspector.test/sub/panels/timeline/snapshot.json')
    expect(requests).toEqual(['resource'])
  })

  it.each(['', '"./asset.svg", "https://other.test/"', '"a", "b", "c"'])(
    'rejects import.meta.resolve with unsupported arity: (%s)', (argumentsText) => {
      expect(() => restoreModuleUrls(timelinePath, `import.meta.resolve(${argumentsText})`)).toThrow(
        `DevTools ${timelinePath}: import.meta.resolve must have one argument`,
      )
    },
  )
})

describe('generated CSS text modules', () => {
  it.each([
    ['empty', ''],
    ['quotes and slashes', '.title::after { content: "double"; other: \'single\'; path: "C:\\icons\\file"; }'],
    ['backticks and interpolation', '/* `template` ${mustNotRun()} */\n.title { content: "${value}"; }'],
    ['line endings', '\uFEFF:root {\r\n  --label: "中文 🚀";\r\n}\n'],
    ['control characters', '/* \u0000\t\u2028\u2029 */'],
    ['script-like text', '\"; throw new Error("must stay text"); /* </script> */'],
  ])('preserves CSS text through module evaluation: %s', (_label, source) => {
    expect(evaluateModule(cssTextModule(source))).toEqual({ default: source })
  })
})

describe('configureHostPerformanceSource', () => {
  it('changes only the recording-mode field and target expression in the installed npm TimelinePanel', () => {
    const source = npmSource(timelinePath)
    expect(source.split(nodeMode)).toHaveLength(2)
    expect(source.split(nodeTarget)).toHaveLength(2)
    expect(configureHostPerformanceSource(timelinePath, source)).toBe(
      source.replace(nodeMode, '#isNode = true;').replace(nodeTarget, primaryTarget),
    )
    expect(npmSource(timelinePath)).toBe(source)
  })

  it('selects the primary target for CPU recording independently of Node target discovery', () => {
    const source = `class Panel {
      ${nodeMode}
      record() { return { isNode: this.#isNode, target: ${nodeTarget} }; }
    }
    new Panel().record();`
    const target = { name: 'Host CPU profiler target' }
    const result: unknown = runInNewContext(configureHostPerformanceSource(timelinePath, source), {
      SDK: { TargetManager: { TargetManager: { instance: () => ({ primaryPageTarget: () => target }) } } },
    })
    expect(result).toEqual({ isNode: true, target })
  })

  it.each(['panels/timeline/TimelineController.ts', 'panels/elements/ElementsPanel.ts', 'core/root/Runtime.ts'])(
    'preserves unrelated npm source %s byte-for-byte', (path) => {
      const source = npmSource(path)
      expect(configureHostPerformanceSource(path, source)).toBe(source)
    },
  )

  it('does not match other paths even when they contain the target expressions', () => {
    const source = `\uFEFF${nodeMode}\r\n${nodeTarget}\r\n`
    for (const path of ['panels/timeline/TimelinePanel.js', `other/${timelinePath}`, `${timelinePath}?raw`]) {
      expect(configureHostPerformanceSource(path, source)).toBe(source)
    }
  })

  it.each([
    ['missing Node mode', nodeMode, '#isNode = false;'],
    ['duplicate Node mode', nodeMode, `${nodeMode}\n${nodeMode}`],
    ['changed target', nodeTarget, 'SDK.TargetManager.TargetManager.instance().rootTarget()'],
    ['duplicate target', nodeTarget, `(${nodeTarget}, ${nodeTarget})`],
  ])('rejects %s in the npm source', (_label, expression, replacement) => {
    const source = npmSource(timelinePath)
    const changed = source.replace(expression, replacement)
    expect(changed).not.toBe(source)
    expect(() => configureHostPerformanceSource(timelinePath, changed)).toThrow(
      `DevTools ${timelinePath}: expected source expression changed: ${expression}`,
    )
  })
})

describe('configureCodeMirrorBrowser', () => {
  const prefix = 'third_party/codemirror/package/'
  const guard = 'typeof exports == "object" && typeof module == "object"'
  const wrapper = `(function(mod) {
    if (${guard}) mod(require('../../lib/codemirror'));
    else mod(CodeMirror);
  })(function(cm) { cm.loaded = true; });`

  it('uses the browser CodeMirror with CJS globals present without calling require', () => {
    const requests: string[] = []
    const CodeMirror = { loaded: false }
    const sandbox = {
      exports: {}, module: { exports: {} }, CodeMirror,
      require: (specifier: string) => { requests.push(specifier); throw new Error('CJS branch selected') },
    }
    expect(() => { runInNewContext(wrapper, sandbox) }).toThrow('CJS branch selected')
    expect(requests).toEqual(['../../lib/codemirror'])
    expect(CodeMirror.loaded).toBe(false)

    const result = configureCodeMirrorBrowser(`${prefix}mode/javascript/javascript.mjs`, wrapper)
    runInNewContext(result, sandbox)
    expect(CodeMirror.loaded).toBe(true)
    expect(requests).toEqual(['../../lib/codemirror'])
    const withoutRequire = { exports: {}, module: { exports: {} }, CodeMirror: { loaded: false } }
    runInNewContext(result, withoutRequire)
    expect(withoutRequire.CodeMirror.loaded).toBe(true)
  })

  it('preserves other paths, extensions and nonmatching guards byte-for-byte', () => {
    const source = `\uFEFF${wrapper}\r\n`
    for (const path of [
      'third_party/other/package/mode.mjs', 'third_party/codemirror/package-other/mode.mjs',
      'panels/codemirror/mode.mjs', `${prefix}mode.js`, `${prefix}mode.ts`, `${prefix}mode.cjs`, `${prefix}mode.mjs?raw`,
    ]) {
      expect(configureCodeMirrorBrowser(path, source)).toBe(source)
    }
    const differentGuard = source.replace(guard, 'typeof exports === "object" && typeof module === "object"')
    expect(configureCodeMirrorBrowser(`${prefix}mode.mjs`, differentGuard)).toBe(differentGuard)
  })

  it('recognizes the npm runmode and mode guards and tokenizes in the browser branch', () => {
    const sources = [
      'addon/runmode/runmode-standalone.mjs', 'mode/javascript/javascript.mjs', 'mode/css/css.mjs', 'mode/xml/xml.mjs',
    ].map((relative) => {
      const path = `${prefix}${relative}`
      const source = npmSource(path)
      expect(source).toContain(guard)
      const result = configureCodeMirrorBrowser(path, source)
      expect(result).toBe(source.replaceAll(guard, 'false'))
      expect(result).not.toContain(guard)
      return result
    })
    const samples = [
      { mode: 'javascript', text: 'var answer = 42;', style: 'keyword' },
      { mode: 'css', text: 'body { color: red; }', style: 'property' },
      { mode: 'xml', text: '<a title="test"/>', style: 'tag' },
    ]
    const tokens: Array<{ mode: string; text: string; style: string | null | undefined }> = []
    const requests: string[] = []
    runInNewContext(sources.join('\n;\n') + `
      for (const sample of ${JSON.stringify(samples)}) {
        CodeMirror.runMode(sample.text, sample.mode, (text, style) => capture(sample.mode, text, style));
      }`, {
      exports: {}, module: { exports: {} },
      require: (specifier: string) => { requests.push(specifier); throw new Error('Unexpected CodeMirror require') },
      capture: (mode: string, text: string, style: string | null | undefined) => { tokens.push({ mode, text, style }) },
    })
    expect(requests).toEqual([])
    for (const sample of samples) {
      const result = tokens.filter(token => token.mode === sample.mode)
      expect(result.map(token => token.text).join('')).toBe(sample.text)
      expect(result.map(token => token.style)).toContain(sample.style)
    }
  })
})

describe('imagesModule', () => {
  it.each([
    { images: [] },
    { images: [{ name: 'nodeIcon.avif' }, { name: 'folder-open.svg' }, { name: 'icon.with.dots.svg' }, { name: 'file name.svg' }] },
  ])('registers flattened images relative to the page and retains adopted sheets: $images', ({ images }) => {
    const registrations: Array<[string, string]> = []
    const rules: string[] = []
    class Sheet {
      readonly cssRules = [{ style: { setProperty: (name: string, value: string) => { registrations.push([name, value]) } } }]
      replaceSync(value: string): void { rules.push(value) }
    }
    const previous = { name: 'existing stylesheet' }
    const adopted: object[] = [previous]
    const document = {
      baseURI: 'https://inspector.test/team/alice/devtools/devtools_app.html?ws=host#console',
      adoptedStyleSheets: adopted,
    }
    runInNewContext(imagesModule(images), { URL, CSSStyleSheet: Sheet, document })
    expect(rules).toEqual([':root {}'])
    expect(registrations).toEqual(images.length === 0 ? [] : [
      ['--image-file-nodeIcon', 'url("https://inspector.test/team/alice/devtools/Images/nodeIcon.avif")'],
      ['--image-file-folder-open', 'url("https://inspector.test/team/alice/devtools/Images/folder-open.svg")'],
      ['--image-file-icon.with.dots', 'url("https://inspector.test/team/alice/devtools/Images/icon.with.dots.svg")'],
      ['--image-file-file name', 'url("https://inspector.test/team/alice/devtools/Images/file%20name.svg")'],
    ])
    expect(document.adoptedStyleSheets).toHaveLength(2)
    expect(document.adoptedStyleSheets[0]).toBe(previous)
    expect(document.adoptedStyleSheets[1]).toBeInstanceOf(Sheet)
    expect(document.adoptedStyleSheets).not.toBe(adopted)
    expect(adopted).toEqual([previous])
  })
})
