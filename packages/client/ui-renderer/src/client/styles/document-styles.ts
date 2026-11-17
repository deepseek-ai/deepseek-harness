/** Ordered module styles owned by one renderer presentation destination. */
import type { ClientModuleMeta } from '@deepseek-ai/dsh-package-manifest'
import type { ClientModuleLoader, ClientModuleRecord } from '@deepseek-ai/dsh-client-modules/client'

interface StyleRecord {
  readonly element: HTMLStyleElement
  css: string
}

/** One stylesheet to install: its owning package, its path within that package, and its text. */
interface RequestedStyle {
  readonly owner: string
  readonly path: string
  css: string
}

/** Stylesheets are identified by owning package and path; `\0` occurs in neither. */
const styleKey = (owner: string, path: string): string => `${owner}\0${path}`

/** CSS text one module record produced, by stylesheet path; a path whose producer failed is absent. */
type ModuleStyles = ReadonlyMap<string, string>

const NO_STYLES: ModuleStyles = new Map()

/**
 * Materialized module styles installed synchronously in the main document. Each style element carries
 * `data-plugin` with the owning package and `data-path` with the stylesheet's path within that package.
 *
 * A module whose metadata or stylesheet text cannot be produced, or whose stylesheet path already carries
 * different CSS within its package, loses only that stylesheet: the failure is reported once on the console and every other
 * stylesheet is installed. A failed producer runs again only for a replacement module record.
 */
export class DocumentStyles {
  private readonly records = new Map<string, StyleRecord>()
  private readonly produced = new WeakMap<ClientModuleRecord, ModuleStyles>()
  /** Stylesheets, by {@link styleKey}, whose current conflict has been reported. */
  private readonly conflicts = new Set<string>()
  private unsubscribe: (() => void) | undefined
  private mounted = false
  private disposed = false

  /** @param container - Style destination. @param modules - This renderer's module service. */
  constructor(
    private readonly container: HTMLElement,
    private readonly modules: Pick<ClientModuleLoader, 'subscribeModules' | 'activeRecords' | 'resolveAsset'>,
  ) {}

  /** Subscribe and synchronously install module styles; each instance can mount only once. */
  mount(): void {
    if (this.disposed) throw new Error('renderer: document styles are disposed')
    if (this.mounted) throw new Error('renderer: document styles are already mounted')
    this.mounted = true
    try {
      this.unsubscribe = this.modules.subscribeModules(() => { if (!this.disposed) this.refresh() })
      this.refresh()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** Unsubscribe and remove all installed resources. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.unsubscribe?.()
    } finally {
      for (const record of this.records.values()) record.element.remove()
      this.records.clear()
    }
  }

  /** Produce one record's stylesheet text once, containing each producer failure to its own stylesheet. */
  private stylesOf(record: ClientModuleRecord): ModuleStyles {
    if (record.meta === undefined) return NO_STYLES
    const cached = this.produced.get(record)
    if (cached !== undefined) return cached
    const styles = new Map<string, string>()
    this.produced.set(record, styles)
    let stylesheets: NonNullable<ClientModuleMeta['stylesheets']>
    try {
      stylesheets = record.meta().stylesheets ?? {}
    } catch (error) {
      console.error(`module styles: metadata of ${JSON.stringify(record.id)} failed; its styles are not installed`, error)
      return styles
    }
    for (const [path, descriptor] of Object.entries(stylesheets)) {
      try {
        styles.set(path, descriptor.text({ asset: reference => this.modules.resolveAsset(reference) }))
      } catch (error) {
        console.error(`module styles: ${JSON.stringify(path)} of ${JSON.stringify(record.id)} failed and is not installed`, error)
      }
    }
    return styles
  }

  private collectStyles(): Map<string, RequestedStyle> {
    const byId = new Map<string, ClientModuleRecord>()
    const groups = new Map<string, ClientModuleRecord[]>()
    for (const record of this.modules.activeRecords()) {
      if (!byId.has(record.id)) byId.set(record.id, record)
      const group = groups.get(record.ownerId)
      if (group === undefined) groups.set(record.ownerId, [record])
      else if (record.id === record.ownerId) group.unshift(record)
      else group.push(record)
    }
    const requested = new Map<string, RequestedStyle>()
    const providers = new Map<string, string>()
    const conflicting = new Set<string>()
    const visited = new Set<string>()
    const visit = (ownerId: string): void => {
      if (visited.has(ownerId)) return
      visited.add(ownerId)
      const records = groups.get(ownerId) ?? []
      for (const record of records) {
        for (const specifier of record.edges) {
          // Relative chunks are already grouped with their owning module.
          if (specifier.startsWith('./')) continue
          const dependency = byId.get(specifier) ?? byId.get(specifier.replace(/\/client$/, ''))
          if (dependency !== undefined) visit(dependency.ownerId)
        }
      }
      for (const record of records) {
        for (const [path, css] of this.stylesOf(record)) {
          const key = styleKey(record.ownerId, path)
          const previous = requested.get(key)
          if (previous === undefined) {
            requested.set(key, { owner: record.ownerId, path, css })
            providers.set(key, record.id)
            continue
          }
          if (previous.css === css) continue
          conflicting.add(key)
          let rejected = record.id
          // The installed text keeps its path, so a module that arrives later cannot restyle a running one.
          if (this.records.get(key)?.css === css) {
            rejected = providers.get(key) ?? rejected
            previous.css = css
            providers.set(key, record.id)
          }
          if (!this.conflicts.has(key)) {
            this.conflicts.add(key)
            console.error(`module styles: ${JSON.stringify(path)} of ${JSON.stringify(rejected)} is not installed; `
              + `another module of ${JSON.stringify(record.ownerId)} provides different CSS for the same path`)
          }
        }
      }
    }
    for (const ownerId of [...groups.keys()].sort()) visit(ownerId)
    for (const key of this.conflicts) if (!conflicting.has(key)) this.conflicts.delete(key)
    return requested
  }

  private refresh(): void {
    const requested = this.collectStyles()
    for (const [key, record] of this.records) {
      if (requested.has(key)) continue
      record.element.remove()
      this.records.delete(key)
    }
    const elements: HTMLStyleElement[] = []
    for (const [key, { owner, path, css }] of requested) {
      let record = this.records.get(key)
      if (record === undefined) {
        const element = this.container.ownerDocument.createElement('style')
        element.setAttribute('data-plugin', owner)
        element.setAttribute('data-path', path)
        element.textContent = css
        record = { element, css }
        this.records.set(key, record)
      } else if (record.css !== css) {
        record.element.textContent = css
        record.css = css
      }
      elements.push(record.element)
    }
    const owned = new Set<Node>(elements)
    const ordered = [...this.container.childNodes].filter((node): node is HTMLStyleElement => owned.has(node))
    for (const [index, element] of elements.entries()) {
      if (ordered[index] === element) continue
      const anchor = ordered[index] ?? ordered.at(-1)?.nextSibling ?? null
      this.container.insertBefore(element, anchor)
      const previous = ordered.indexOf(element)
      if (previous !== -1) ordered.splice(previous, 1)
      ordered.splice(index, 0, element)
    }
  }
}
