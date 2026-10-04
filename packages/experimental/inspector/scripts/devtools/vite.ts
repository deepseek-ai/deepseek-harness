/** Vite compilation of the immutable npm DevTools frontend and its runtime-fetched assets. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin, type InlineConfig } from 'vite'
import { frontendImages, frontendSourceRoot, imagesModule } from './inputs.ts'
import { configureCodeMirrorBrowser, configureHostPerformanceSource, cssTextModule, restoreModuleUrls } from './source.ts'

const assets = fileURLToPath(new URL('../../assets/devtools/', import.meta.url))
const CONNECT = join(assets, 'connect.js')
const VIRTUAL = '\0dsh-devtools:'
const EMPTY = `${VIRTUAL}empty`
const ENTRIES = ['devtools_app', 'device_mode_emulation_frame', 'formatter_worker', 'heap_snapshot_worker', 'wasmparser_worker', 'lighthouse_worker'] as const

/**
 * Build the English-only frontend from installed npm sources and local integration assets.
 * @param output - Private output directory owned by the outer publication step.
 */
export async function buildFrontend(output: string): Promise<void> {
  const root = await frontendSourceRoot()
  const front = join(root, 'front_end')
  const images = await frontendImages(front)
  const generated = new Map<string, string>([
    ['Images/Images.js', imagesModule(images)],
    // An empty dictionary makes upstream i18n use the English UIStrings embedded in each module.
    ['core/i18n/locales.js', `export const LOCALES = ["en-US"], BUNDLED_LOCALES = LOCALES, DEFAULT_LOCALE = "en-US";
export const LOCAL_FETCH_PATTERN = "data:application/json,{}", REMOTE_FETCH_PATTERN = LOCAL_FETCH_PATTERN;`],
    ['panels/timeline/EasterEgg.js', 'export const SHOULD_SHOW_EASTER_EGG = false;'],
  ])
  const sourcePlugin = (): Plugin => ({
    name: 'dsh-devtools-source', enforce: 'pre',
    async resolveId(request, importer) {
      if (request === 'puppeteer' || request === 'lighthouse' || request === 'node:util' || request.includes('/NodeWebSocketTransport.js')) return EMPTY
      if (!importer || (!request.startsWith('.') && !isAbsolute(request))) return null
      const file = resolve(importer === CONNECT ? front : dirname(importer.split('?')[0]!), request)
      const sourcePath = relative(front, file).split('\\').join('/')
      if (generated.has(sourcePath)) return `${VIRTUAL}${sourcePath}`
      if (sourcePath === 'core/platform/node/node.js') return join(front, 'core/platform/browser/browser.ts')
      if (file.endsWith('.css.js')) return `${VIRTUAL}css:${file.slice(0, -3)}.mjs`
      if (file.endsWith('.js')) {
        const tsFile = file.slice(0, -3) + '.ts'
        try { if ((await stat(tsFile)).isFile()) return tsFile } catch (error) {
          if (!isMissing(error)) throw error
        }
      }
      return null
    },
    async load(id) {
      if (id === EMPTY) return 'export {};'
      if (id.startsWith(`${VIRTUAL}css:`)) {
        const path = id.slice(`${VIRTUAL}css:`.length, -4)
        this.addWatchFile(path)
        return cssTextModule(await readFile(path, 'utf8'))
      }
      if (id.startsWith(VIRTUAL)) return generated.get(id.slice(VIRTUAL.length))
      return null
    },
    transform(code, id) {
      if (!id.replaceAll('\\', '/').startsWith(front.replaceAll('\\', '/') + '/') || !/\.(?:ts|m?js)$/u.test(id)) return null
      const path = relative(front, id).split('\\').join('/')
      return { code: restoreModuleUrls(path, configureCodeMirrorBrowser(path,
        configureHostPerformanceSource(path, code))), map: null }
    },
  })
  const base: InlineConfig = {
    configFile: false, root: front, logLevel: 'warn', publicDir: false,
    // Upstream modules use const-enum members before their declarations.
    oxc: { target: 'es2022', typescript: { optimizeConstEnums: true }, decorator: { legacy: true } },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  }
  const injected: Array<{ path: string; bytes: string }> = []
  for (const directory of ['panels/recorder/injected/injected', 'models/live-metrics/web-vitals-injected/web-vitals-injected']) {
    const result = await build({ ...base, plugins: [sourcePlugin()], build: {
      write: false, minify: 'oxc', target: 'es2022', sourcemap: false,
      lib: { entry: join(front, `${directory}.ts`), name: 'DevToolsInjected', formats: ['iife'] },
    } })
    const outputs = Array.isArray(result) ? result : [result]
    const chunks = outputs.flatMap(item => 'output' in item ? item.output.filter(file => file.type === 'chunk') : [])
    if (chunks.length !== 1) throw new Error(`DevTools injected script must produce one chunk: ${directory}`)
    injected.push({ path: `${directory}.generated.js`, bytes: chunks[0]!.code })
  }
  const entryFiles = Object.fromEntries(ENTRIES.map(name => [name, `entrypoints/${name}/${name}${name.endsWith('_worker') && name !== 'lighthouse_worker' ? '-entrypoint' : ''}.js`]))
  const input = Object.fromEntries(ENTRIES.map(name => [name, join(front, entryFiles[name]!.replace(/\.js$/u, '.ts'))]))
  input.connect = CONNECT
  await build({ ...base, plugins: [sourcePlugin(), {
    name: 'dsh-devtools-static-assets',
    async generateBundle() {
      const emit = (fileName: string, source: string | Uint8Array): void => { this.emitFile({ type: 'asset', fileName, source }) }
      for (const file of ['application_tokens.css', 'design_system_tokens.css']) emit(file, await readFile(join(front, file)))
      for (const image of images) emit(`Images/${image.name}`, await readFile(image.source))
      for (const dir of ['models/issues_manager/descriptions', 'panels/whats_new/resources', 'emulated_devices/optimized']) {
        for (const file of await filesUnder(join(front, dir))) emit(`${dir}/${file}`, await readFile(join(front, dir, file)))
      }
      for (const file of await filesUnder(join(front, 'third_party'))) {
        if (/(?:^|\/)(?:LICENSE|NOTICE|COPYING)(?:\.[^/]*)?$/u.test(file)) {
          emit(`third_party/${file}`, await readFile(join(front, 'third_party', file)))
        }
      }
      for (const asset of injected) emit(asset.path, asset.bytes)
      emit('LICENSE', await readFile(join(assets, 'LICENSE')))
      for (const name of ['devtools_app', 'device_mode_emulation_frame']) {
        const html = await readFile(join(front, 'entrypoint_template.html'), 'utf8')
        const source = html.replaceAll('%ENTRYPOINT_NAME%', name)
          .replace(' https://chrome-devtools-frontend.appspot.com', '')
          .replace(/<script type="module"/u, name === 'devtools_app' ? '<script type="module" src="./connect.js"></script><script type="module"' : '<script type="module"')
        if (source.includes('%ENTRYPOINT_NAME%')) throw new Error('DevTools HTML entry placeholder changed')
        emit(`${name}.html`, source)
      }
    },
  }], build: {
    outDir: output, emptyOutDir: true, minify: 'oxc', sourcemap: false, target: 'es2022', modulePreload: false,
    lib: { entry: input, formats: ['es'] },
    rolldownOptions: { output: {
      entryFileNames: chunk => chunk.name === 'connect' ? 'connect.js' : entryFiles[chunk.name]!,
      chunkFileNames: 'chunks/[name]-[hash].js',
    } },
  } })
}

async function filesUnder(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) files.push(...await filesUnder(root, path))
    else if (item.isFile() && !/\.(?:ts|gn|md\.in)$/u.test(path) && path !== 'README.md') files.push(path)
  }
  return files.sort()
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
