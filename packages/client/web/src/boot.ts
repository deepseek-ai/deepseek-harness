/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page; plugin composition and the renderer handoff are
 * `bootClient` and `mountClient`. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import type {
  BootManifest, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import { bootClient } from './boot-client.ts'
import { BootPage } from './boot-page.ts'
import { mountClient } from './mount.ts'
import { getStaticModules } from './seed.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every client entry, then hand the mount point to the
   * UI renderer. Plugin failures remain visible on the boot page.
   * @returns Resolves after application mount or failure rendering.
   */
  async run(): Promise<void> {
    try {
      // Boot-readiness gate: whichever bootstrap applies the injection table
      // settles this deferred once every row has taken effect — the served
      // index resolves it in the rendered tail, so the await returns on the
      // next microtask; an asynchronous bootstrap resolves it after its last
      // row, or rejects it into the failure rendering below. An absent global
      // means no bootstrap owns the document and there is nothing to wait for.
      await (globalThis as { __DSH_BOOT_READY__?: { promise: Promise<void> } }).__DSH_BOOT_READY__?.promise
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      // A pre-injected transport (the worker preview page) owns bundle bytes;
      // its loadBundle is the default and explicit seams still win. The global
      // is `ClientTransportHooks`, owned by @deepseek-ai/dsh-client-connection;
      // this structural slice reads one optional member without adding a
      // package edge.
      const transport = (globalThis as {
        __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
      }).__DSH_TRANSPORT__
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
        ...this.seams,
      })
      this.manifest = this.modules.manifest

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      this.page.setTotal(this.manifest.plugins.length)
      await prefetching
      await bootClient({
        ctx,
        modules: this.modules,
        manifest: this.manifest,
        onEntryState: (name, state) => { this.page.setState(name, state) },
      })
      await mountClient(ctx, this.container)
    } catch (reason) {
      console.error(reason)
      this.page.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page.dispose()
  }

  /** Prefetch stage-one bundles and their dynamic requests before concurrent plugin imports. */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }
}
