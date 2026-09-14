/** Exercise real Vite build inputs, including files absent from ordinary chunk imports. */

import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { browserDependencyAnalysis, productWebBundleIsolation } from '../apps/web/product-isolation.ts'
import { WebProductBundleIsolation } from './web-product-bundle-isolation.ts'
import { BundleInputIsolation } from './bundle-input-isolation.ts'

const filesystem = vi.hoisted(() => ({ missingRoot: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => !filesystem.missingRoot && actual.existsSync(path),
  }
})

// Vite is owned by the Web app rather than the repository's scripting dependencies.
const vite = createRequire(new URL('../apps/web/package.json', import.meta.url))('vite') as {
  build(config: Record<string, unknown>): Promise<unknown>
}

function fixture() {
  // Vite resolves inputs with native realpath, which expands Windows short names.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-web-bundle-isolation-')))
  const web = join(root, 'apps/web')
  const links: string[] = []
  onTestFinished(() => {
    for (const path of links) unlinkSync(path)
    rmSync(root, { recursive: true, force: true })
  })
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  write('package.json', '{"name":"isolation-fixture","type":"module"}')
  write('apps/web/package.json', '{"name":"@deepseek-ai/dsh-web-frontend","type":"module"}')
  write('apps/web/index.html', '<script type="module" src="/src/main.js"></script>')
  write('apps/web/src/main.js', 'globalThis.product = true')
  write('apps/web/src/preview.js', 'import "../../../packages/experimental/prototype/index.js"')
  write('packages/experimental/prototype/package.json', '{"name":"@deepseek-ai/dsh-experimental-prototype","type":"module"}')
  write('packages/experimental/prototype/index.js', 'globalThis.experimental = true')
  write('packages/experimental/prototype/style.css', '.experimental { color: red }')
  write('packages/experimental/prototype/tiny.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const run = (extra: Record<string, unknown> = {}): Promise<unknown> => vite.build({
    configFile: false,
    root: web,
    logLevel: 'silent',
    plugins: productWebBundleIsolation(root, web),
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: { index: join(web, 'index.html'), bootstrap: join(web, 'src/preview.js') },
      },
    },
    ...extra,
  })
  return { root, web, write, run, links }
}

describe('default Web bundle input isolation', () => {
  it('requires explicit analysis intent before allowing externalized inputs in a non-writing build', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "external-lib"; globalThis.product = true')
    const externalize = {
      name: 'fixture-external-analysis',
      resolveId(id: string) { return id === 'external-lib' ? { id, external: true } : null },
    }
    await expect(test.run({ plugins: [...productWebBundleIsolation(test.root, test.web), externalize] }))
      .rejects.toThrow(/external module external-lib has no bundled input proof/)
    await expect(test.run({ plugins: [
      ...productWebBundleIsolation(test.root, test.web), browserDependencyAnalysis(), externalize,
    ] })).resolves.toBeDefined()
    expect(existsSync(join(test.web, 'dist'))).toBe(false)
  })

  it('refuses output writing when dependency analysis bypasses the product check', async () => {
    const test = fixture()
    const output = join(test.root, 'analysis-output')
    await expect(test.run({
      plugins: [...productWebBundleIsolation(test.root, test.web), browserDependencyAnalysis()],
      build: { write: true, outDir: output },
    })).rejects.toThrow(/browser dependency analysis requires build.write: false/)
    expect(existsSync(output)).toBe(false)
  })

  it('allows experimental code in the separately emitted preview entry', async () => {
    await expect(fixture().run()).resolves.toMatchObject({
      output: expect.arrayContaining([
        expect.objectContaining({ type: 'asset', fileName: 'index.html' }),
        expect.objectContaining({ type: 'chunk', name: 'bootstrap' }),
      ]) as unknown,
    })
  })

  it.each([
    ['static import', 'import "../../../packages/experimental/prototype/index.js"'],
    ['dynamic import', 'void import("../../../packages/experimental/prototype/index.js")'],
    ['raw query import', 'import text from "../../../packages/experimental/prototype/index.js?raw"; console.log(text)'],
  ])('rejects a product %s of experimental input', async (_name, source) => {
    const test = fixture()
    test.write('apps/web/src/main.js', source)
    await expect(test.run()).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('checks inline HTML modules after Vite resolves and bundles them', async () => {
    const test = fixture()
    test.write('apps/web/index.html', '<script type="module">import "../../packages/experimental/prototype/index.js"</script>')
    await expect(test.run()).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('checks resolver aliases by the actual file owner', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "feature"')
    await expect(test.run({ resolve: { alias: { feature: join(test.root, 'packages/experimental/prototype/index.js') } } }))
      .rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('checks npm alias package identity independently of its directory name', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "ordinary-name"')
    test.write('apps/web/node_modules/ordinary-name/package.json',
      '{"name":"@deepseek-ai/dsh-experimental-aliased","type":"module","main":"index.js"}')
    test.write('apps/web/node_modules/ordinary-name/index.js', 'globalThis.aliased = true')
    await expect(test.run()).rejects.toThrow(/belongs to experimental package/)
  })

  it('follows virtual module edges to their resolved inputs', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "virtual:feature"')
    await expect(test.run({ plugins: [...productWebBundleIsolation(test.root, test.web), {
      name: 'fixture-virtual-module',
      resolveId(id: string) { return id === 'virtual:feature' ? '\u0000virtual:feature' : null },
      load(id: string) {
        return id === '\u0000virtual:feature'
          ? `import ${JSON.stringify(join(test.root, 'packages/experimental/prototype/index.js'))}` : null
      },
    }] })).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('rejects experimental inputs merged into a product-reachable shared chunk', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "./shared.js"; globalThis.product = true')
    test.write('apps/web/src/shared.js', 'globalThis.shared = true')
    await expect(test.run({ build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: { index: join(test.web, 'index.html'), bootstrap: join(test.web, 'src/preview.js') },
        output: { manualChunks: (id: string) => id.endsWith('/shared.js') || id.includes('/packages/experimental/')
          ? 'shared' : undefined },
      },
    } })).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('checks symlinked package ownership', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "ordinary-name/index.js"')
    const link = join(test.web, 'node_modules/ordinary-name')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(test.root, 'packages/experimental/prototype'), link, process.platform === 'win32' ? 'junction' : 'dir')
    test.links.push(link)
    await expect(test.run({ resolve: { preserveSymlinks: true } }))
      .rejects.toThrow(/Web product isolation: experimental input/)
  })

  it.each([
    ['stylesheet import', '@import "../../../packages/experimental/prototype/style.css";'],
    ['inlined image', '.product { background: url("../../../packages/experimental/prototype/tiny.svg") }'],
    ['emitted image', '.product { background: url("../../../packages/experimental/prototype/tiny.svg?no-inline") }'],
  ])('checks the actual CSS transform inputs for %s', async (_name, css) => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "./style.css"; globalThis.product = true')
    test.write('apps/web/src/style.css', css)
    await expect(test.run()).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('allows experimental CSS only used by preview', async () => {
    const test = fixture()
    test.write('apps/web/src/preview.js', 'import "./preview.css"; globalThis.preview = true')
    test.write('apps/web/src/preview.css', '@import "../../../packages/experimental/prototype/style.css";')
    await expect(test.run()).resolves.toBeDefined()
  })

  it.each([
    ['URL worker', 'new Worker(new URL("./worker.js", import.meta.url), { type: "module" })'],
    ['inline worker', 'import Worker from "./worker.js?worker&inline"; new Worker()'],
  ])('checks %s subbuild inputs when the product loads it', async (_name, source) => {
    const test = fixture()
    test.write('apps/web/src/main.js', source)
    test.write('apps/web/src/worker.js', 'import "../../../packages/experimental/prototype/index.js"')
    await expect(test.run()).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('allows an experimental worker loaded only by preview', async () => {
    const test = fixture()
    test.write('apps/web/src/preview.js', 'new Worker(new URL("./worker.js", import.meta.url), { type: "module" })')
    test.write('apps/web/src/worker.js', 'import "../../../packages/experimental/prototype/index.js"')
    await expect(test.run()).resolves.toBeDefined()
  })

  it('rejects an emitted entry without its original HTML input', () => {
    const test = fixture()
    const inputs = new WebProductBundleIsolation(test.root, test.web)
    expect(() => { inputs.verify({}, () => null) }).toThrow(/index.html is missing its original HTML input/)
  })

  it('rejects a worker asset whose subbuild was not observed', () => {
    const test = fixture()
    const inputs = new WebProductBundleIsolation(test.root, test.web)
    inputs.assetReference('worker.js', 'index.html', 'asset')
    expect(() => { inputs.verify({
      'index.html': { type: 'asset', fileName: 'index.html', names: ['index.html'], originalFileNames: ['index.html'] },
      'worker.js': { type: 'asset', fileName: 'worker.js', names: [], originalFileNames: [] },
    }, () => null) }).toThrow(/worker.js has no recorded original files/)
  })
})

describe('bundler input ownership', () => {
  it('refuses source-map paths whose filesystem root is unavailable', () => {
    const test = fixture()
    const ownership = new BundleInputIsolation(test.root, 'fixture')
    filesystem.missingRoot = true
    try {
      expect(() => { ownership.assertSourceMapInput(join(test.web, 'missing/source.js')) })
        .toThrow(/has no existing filesystem root/)
    } finally {
      filesystem.missingRoot = false
    }
  })

  it('retains ownership through queries, filesystem URLs, and virtual path wrappers', () => {
    const test = fixture()
    const ownership = new BundleInputIsolation(test.root, 'fixture')
    const file = join(test.root, 'packages/experimental/prototype/index.js')
    for (const id of [file, `${file}?raw`, `${pathToFileURL(file).href}?import`, `\u0000${file}?commonjs-proxy`,
      `virtual:${file}`, `/@fs/${file.replaceAll('\\', '/')}`, file.replaceAll('/', '\\')]) {
      expect(() => { ownership.assertInput(id) }, id).toThrow(/experimental input/)
    }
  })

  it('distinguishes missing actual inputs from omitted upstream source-map files', () => {
    const test = fixture()
    const ownership = new BundleInputIsolation(test.root, 'fixture')
    const file = join(test.web, 'node_modules/upstream/src/omitted.js')
    test.write('apps/web/node_modules/upstream/package.json', '{"name":"upstream"}')
    expect(() => { ownership.assertInput(file) }).toThrow(/is missing/)
    expect(() => { ownership.assertSourceMapInput(file) }).not.toThrow()
    test.write('apps/web/node_modules/upstream/package.json', '{"name":"@deepseek-ai/dsh-experimental-upstream"}')
    ownership.reset()
    expect(() => { ownership.assertSourceMapInput(file) }).toThrow(/belongs to experimental package/)
  })
})
