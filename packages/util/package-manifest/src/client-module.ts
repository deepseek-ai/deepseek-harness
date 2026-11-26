/** Browser module artifacts shared by builders, loaders, and renderer resource consumers. */

/** Metadata of one module artifact, with independently evaluated stylesheet text. */
export interface ClientModuleMeta {
  /** Stylesheets keyed by their path within the module's owning package, such as `src/client/App.module.css`. */
  readonly stylesheets?: Readonly<Record<string, ClientModuleStylesheetDescriptor>>
}

/** One stylesheet's metadata and deferred text producer. */
export interface ClientModuleStylesheetDescriptor {
  readonly text: (context: ClientModuleStyleContext) => string
}

/** Existing package-asset resolution available while producing stylesheet text. */
export interface ClientModuleStyleContext {
  /** Resolve a package asset reference without loading another module. */
  asset(reference: string): string
}

/** Produce resource metadata without evaluating stylesheet text. */
export type ClientModuleMetaFactory = () => ClientModuleMeta

/** Dependency resolver supplied to a JavaScript module factory. */
export interface ClientBundleRequire {
  /** Resolve a previously arrived shared module, or a registered chunk of the owning package (`./client.<name>.js`), synchronously. */
  (specifier: string): unknown
  /**
   * Load a module or an owning package's relative chunk using the existing module request semantics.
   * `options` applies only to a relative chunk request; another package's request ignores it.
   */
  async(specifier: string, options?: ClientAsyncRequireOptions): Promise<unknown>
  /** Resolve a package asset reference. */
  asset(reference: string): string
}

/** Options of one asynchronous package-local chunk request. */
export interface ClientAsyncRequireOptions {
  /**
   * Chunks of the owning package (`./client.<name>.js`) to download in parallel with the requested chunk. The list
   * only saves round trips: the requested chunk's registration `deps` still decide what must arrive before it runs.
   */
  readonly deps?: readonly string[]
}

/** Materialize JavaScript exports without producing stylesheet resources. */
export type ClientModuleFactory = (require: ClientBundleRequire) => Record<string, unknown>

/** One executable browser entry or package-local chunk with optional deferred metadata. */
export interface DshClientModuleManifest {
  readonly id: string
  readonly chunk?: string
  /**
   * Chunks of the same package (`./client.<name>.js`) that the factory requires synchronously. The module system
   * registers each of them, and their own `deps`, before it runs the factory.
   */
  readonly deps?: readonly string[]
  readonly factory: ClientModuleFactory
  readonly meta?: ClientModuleMetaFactory
}
