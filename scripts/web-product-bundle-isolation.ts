/** Experimental-package isolation over Vite's emitted product graph and recorded file inputs. */

import { basename, resolve } from 'node:path'
import { BundleInputIsolation, physicalBundleInput } from './bundle-input-isolation.ts'

/** The emitted chunk fields used to follow the product's actual output graph. */
export interface WebOutputChunk {
  type: 'chunk'
  fileName: string
  preliminaryFileName?: string
  facadeModuleId: string | null
  modules: Record<string, unknown>
  imports: string[]
  dynamicImports: string[]
  implicitlyLoadedBefore: string[]
  referencedFiles: string[]
  viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> }
}

/** Original file names provide ownership for emitted, non-CSS assets. */
export interface WebOutputAsset {
  type: 'asset'
  fileName: string
  names: string[]
  originalFileNames: string[]
}

/** Vite's output bundle, restricted to the fields needed by this check. */
export type WebOutputBundle = Record<string, WebOutputChunk | WebOutputAsset>

/** Retained source edges, including CSS modules whose pure output chunks Vite removes. */
export interface WebModuleInfo {
  importedIds: readonly string[]
  dynamicallyImportedIds: readonly string[]
  isExternal: boolean
  isIncluded: boolean | null
}

interface AssetReference {
  host: string
  file: string
  type: 'asset' | 'public'
}

/** Output graphs are rebuilt each time; cached transforms retain their file-input observations. */
export class WebProductBundleIsolation {
  private readonly cssInputs = new Map<string, Set<string>>()
  private readonly chunks = new Map<string, WebOutputChunk>()
  private readonly references: AssetReference[] = []
  private readonly workerInputs = new Map<string, Set<string>>()
  private readonly inputs: BundleInputIsolation
  private readonly webRoot: string

  constructor(repository: string, webRoot: string) {
    this.webRoot = webRoot
    this.inputs = new BundleInputIsolation(repository, 'Web product isolation')
  }

  /** Discard output graphs and package metadata before a build or watch rebuild. */
  reset(): void {
    this.chunks.clear()
    this.references.length = 0
    this.workerInputs.clear()
    this.inputs.reset()
  }

  /** Replace dependency observations whenever Vite transforms a module again. */
  cssTransform(module: string): void { this.cssInputs.set(module, new Set<string>()) }

  /** Record the files the actual CSS transform asks Rollup to watch. */
  cssDependency(module: string, file: string): void {
    const inputs = this.cssInputs.get(module) ?? new Set<string>()
    inputs.add(file)
    this.cssInputs.set(module, inputs)
  }

  /** Record Vite's asset URL edges without changing their rendered values. */
  assetReference(file: string, host: string, type: 'asset' | 'public'): void {
    this.references.push({ file, host, type })
  }

  /** Preserve pure CSS chunk inputs before Vite removes their JavaScript wrappers. */
  captureChunks(bundle: WebOutputBundle): void {
    for (const item of Object.values(bundle)) {
      if (item.type !== 'chunk') continue
      this.chunks.set(item.fileName, {
        ...item,
        modules: { ...item.modules },
        imports: [...item.imports],
        dynamicImports: [...item.dynamicImports],
        implicitlyLoadedBefore: [...item.implicitlyLoadedBefore],
        referencedFiles: [...item.referencedFiles],
        ...(item.viteMetadata === undefined ? {} : { viteMetadata: {
          importedCss: new Set(item.viteMetadata.importedCss),
          importedAssets: new Set(item.viteMetadata.importedAssets),
        } }),
      })
    }
  }

  /** Each Vite worker subbuild has one entry and owns its complete watched input set. */
  workerBundle(bundle: WebOutputBundle, watchedFiles: readonly string[]): void {
    const inputs = new Set(watchedFiles)
    const entries: string[] = []
    for (const item of Object.values(bundle)) {
      if (item.type === 'chunk') {
        for (const id of Object.keys(item.modules)) inputs.add(id)
        if (item.facadeModuleId !== null) entries.push(physicalBundleInput(item.facadeModuleId) ?? item.facadeModuleId)
      }
    }
    for (const file of [...Object.keys(bundle), ...entries]) {
      this.workerInputs.set(file, new Set([...this.workerInputs.get(file) ?? [], ...inputs]))
    }
  }

  /** Reject experimental ownership in everything the emitted index page can load. */
  verify(bundle: WebOutputBundle, moduleInfo: (id: string) => WebModuleInfo | null): void {
    const html = bundle['index.html']
    if (html?.type !== 'asset' || !html.originalFileNames.some(file =>
      resolve(this.webRoot, file) === resolve(this.webRoot, 'index.html'))) {
      throw new Error('Web product isolation: emitted index.html is missing its original HTML input')
    }
    const outputs = new Map(Object.entries(bundle))
    const aliases = new Map<string, string>()
    const cssOwners = new Map<string, Set<string>>()
    for (const [file, chunk] of this.chunks) {
      aliases.set(chunk.preliminaryFileName ?? file, file)
      for (const css of chunk.viteMetadata?.importedCss ?? []) {
        const owners = cssOwners.get(css) ?? new Set<string>()
        for (const id of Object.keys(chunk.modules)) owners.add(id)
        cssOwners.set(css, owners)
      }
    }
    for (const item of Object.values(bundle)) {
      if (item.type === 'asset') {
        for (const name of item.names) aliases.set(name, item.fileName)
      }
    }
    const outputName = (name: string): string => outputs.has(name) ? name
      : aliases.get(name) ?? aliases.get(basename(name)) ?? name
    const references = new Map<string, AssetReference[]>()
    for (const reference of this.references) {
      const host = outputName(reference.host)
      references.set(host, [...references.get(host) ?? [], reference])
    }
    const visitedOutputs = new Set<string>()
    const visitedModules = new Set<string>()
    const queue = ['index.html']
    const checkWorker = (key: string): void => {
      const inputs = this.workerInputs.get(key)
      if (inputs === undefined) throw new Error(`Web product isolation: worker ${key} has no recorded build inputs`)
      for (const input of inputs) this.inputs.assertInput(input)
    }
    const checkModule = (id: string): void => {
      if (visitedModules.has(id)) return
      visitedModules.add(id)
      this.inputs.assertInput(id)
      const info = moduleInfo(id)
      if (info === null) throw new Error(`Web product isolation: module ${id} has no Rollup module record`)
      if (info.isExternal) throw new Error(`Web product isolation: external module ${id} has no bundled input proof`)
      if (/\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/i.test(id) && !this.cssInputs.has(id)) {
        throw new Error(`Web product isolation: stylesheet ${id} has no recorded transform inputs`)
      }
      if (/[?&](?:sharedworker|worker)(?:&|$)/.test(id)) checkWorker(physicalBundleInput(id) ?? id)
      for (const file of this.cssInputs.get(id) ?? []) this.inputs.assertInput(file)
      for (const child of [...info.importedIds, ...info.dynamicallyImportedIds]) {
        const childInfo = moduleInfo(child)
        if (childInfo === null) throw new Error(`Web product isolation: module ${child} has no Rollup module record`)
        if (childInfo.isIncluded || childInfo.isExternal) checkModule(child)
      }
    }
    for (const name of queue) {
      const file = outputName(name)
      if (visitedOutputs.has(file)) continue
      visitedOutputs.add(file)
      const item = outputs.get(file)
      if (item === undefined) throw new Error(`Web product isolation: referenced output ${file} is missing`)
      if (this.workerInputs.has(file)) checkWorker(file)
      else if (item.type === 'chunk') {
        for (const id of Object.keys(item.modules)) checkModule(id)
        queue.push(...item.imports, ...item.dynamicImports, ...item.implicitlyLoadedBefore, ...item.referencedFiles)
        queue.push(...item.viteMetadata?.importedCss ?? [], ...item.viteMetadata?.importedAssets ?? [])
      } else if (cssOwners.has(file)) {
        for (const id of cssOwners.get(file) ?? []) checkModule(id)
      } else {
        if (item.originalFileNames.length === 0) {
          throw new Error(`Web product isolation: asset ${file} has no recorded original files`)
        }
        for (const original of item.originalFileNames) this.inputs.assertInput(resolve(this.webRoot, original))
      }
      for (const reference of references.get(file) ?? []) {
        if (reference.type === 'public') this.inputs.assertInput(resolve(this.webRoot, 'public', reference.file))
        else queue.push(reference.file)
      }
    }
    if (visitedModules.size === 0) throw new Error('Web product isolation: index.html has no recorded reachable modules')
  }

}
