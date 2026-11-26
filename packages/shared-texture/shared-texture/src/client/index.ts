/**
 * Client plugin that exposes the host shell's renderer texture bridge as `ctx.sharedTexture`.
 * @module @deepseek-ai/dsh-shared-texture/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SharedTextureClientExport, SharedTextureHostExport } from '../types.ts'

export type { SharedTextureClientExport, SharedTextureHostExport, SharedTextureLease } from '../types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Renderer shared-texture bridge; present only in documents whose host shell exposes one, so consumers inject or
     * read `ctx.get('sharedTexture')` instead of inspecting host globals. The value is the shell's own bridge object:
     * one consumer registers through {@link SharedTextureClientExport.onFrame}, and every delivered lease is released after
     * the GPU work that read it completes.
     */
    sharedTexture: SharedTextureClientExport
  }
}

/**
 * Provide the bridge that Desktop's product preload exposes as `dshDesktop.textures`; other documents get no
 * `ctx.sharedTexture`.
 * @param ctx - Plugin-owned Client context; the provision ends with it.
 */
export function apply(ctx: Context): void {
  const textures = (globalThis as typeof globalThis & SharedTextureHostExport).dshDesktop?.textures
  if (textures !== undefined) ctx.provide('sharedTexture', textures)
}
