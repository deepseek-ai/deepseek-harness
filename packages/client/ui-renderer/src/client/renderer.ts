/** Application root and document stylesheet ownership. */
import { createElement, useLayoutEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import type { UiRendererService } from './index.ts'
import { buildRenderApp } from './app.tsx'
import { DocumentStyles } from './styles/document-styles.ts'

interface BootSnapshot {
  className: string
  html: string
}

/** Hydrate the kernel-owned loading DOM before replacing it with the application. */
function BootHandoff(props: { app: () => ReactNode; boot: BootSnapshot }): ReactNode {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => { setReady(true) }, [])
  if (ready) return props.app()
  return createElement('div', {
    className: props.boot.className,
    'data-dsh-boot': '',
    dangerouslySetInnerHTML: { __html: props.boot.html },
  })
}

/** Mount React while preserving the framework-free boot DOM through hydration. */
function mountApp(container: HTMLElement, app: () => ReactNode): Root {
  const boot = container.querySelector<HTMLElement>(':scope > [data-dsh-boot]')
  if (boot !== null) {
    return hydrateRoot(container, createElement(BootHandoff, {
      app,
      boot: { className: boot.className, html: boot.innerHTML },
    }))
  }
  const root = createRoot(container)
  try {
    flushSync(() => { root.render(app()) })
    return root
  } catch (error) {
    try {
      root.unmount()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'renderer: render and root cleanup failed', { cause: error })
    }
    throw error
  }
}

/** Resources belonging to one mount, retained so stale cleanup cannot affect a later mount. */
interface RendererMount {
  readonly styles: DocumentStyles
  root?: Root
  releasing?: boolean
}

/** Owns the current application root and its document styles. */
export class UiRenderer implements UiRendererService {
  private current: RendererMount | undefined
  private disposed = false

  constructor(private readonly ctx: Context) {}

  mount(container: HTMLElement): () => void {
    if (this.disposed) throw new Error('renderer: cannot mount a disposed renderer')
    if (this.current !== undefined) throw new Error('renderer: application is already mounted')
    const mounted: RendererMount = {
      styles: new DocumentStyles(container.ownerDocument.head, this.ctx.modules),
    }
    this.current = mounted
    try {
      mounted.styles.mount()
      const root = mountApp(container, buildRenderApp({ ctx: this.ctx }))
      if (this.current !== mounted) {
        root.unmount()
        throw new Error('renderer: disposed during application mount')
      }
      mounted.root = root
    } catch (error) {
      try {
        this.unmount(mounted)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'renderer: mount and cleanup failed', { cause: error })
      }
      throw error
    }
    return () => { this.unmount(mounted) }
  }

  /** Close the renderer and release its current root and styles. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.current !== undefined) this.unmount(this.current)
  }

  private unmount(mounted: RendererMount): void {
    if (this.current !== mounted || mounted.releasing) return
    mounted.releasing = true
    const failures: unknown[] = []
    try {
      mounted.root?.unmount()
    } catch (error) {
      failures.push(error)
    }
    try {
      mounted.styles.dispose()
    } catch (error) {
      failures.push(error)
    } finally {
      this.current = undefined
    }
    if (failures.length > 0) throw new AggregateError(failures, 'renderer: unmount cleanup failed')
  }
}
