/**
 * Frame-forwarding Client plugin: mounts the generated `frameForwarding` Remote contribution and provides the
 * renderer-side `frameForwarding` service to consumers. The entry module supplies the contribution, so specs mount a
 * fake one. When `ctx.sharedTexture` is absent, the service is not provided.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-shared-texture/client'
import type { FrameForwardingClient } from './api.ts'
import { FrameForwardingClientService } from './service.ts'

export type { FrameForwardingClient, FrameForwardingFrame, FrameMountOptions } from './api.ts'
export type { FrameRx } from './rx.ts'
export type { FrameDiscardedError, FrameFailureError } from './errors.ts'

/** The Remote transport is the only Client dependency. */
export const inject = ['remote']

/** Provide the renderer-side service while `ctx.sharedTexture` is provided. */
function register(ctx: Context): void {
  ctx.provide('frameForwarding', new FrameForwardingClientService(ctx, ctx.sharedTexture))
}

/**
 * Mount the frame-forwarding Remote contribution and provide the Client service.
 * @param ctx - Client plugin scope.
 * @param contribution - Generated `frameForwarding` Remote contribution.
 * @returns Disposer withdrawing the service before its Remote contribution.
 */
export async function mountFrameForwarding(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const service = ctx.inject(['sharedTexture', 'remote.frameForwarding'], register)
  if (ctx.get('sharedTexture') !== undefined) {
    try { await service } catch (error) { await service.dispose(); await unmountRemote(); throw error }
  }
  return async () => { await service.dispose(); await unmountRemote() }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Renderer-side frame forwarding; provided only in a document that displays the Host's frames, the Desktop
     * document, so consumers test for the service rather than for Desktop.
     */
    frameForwarding: FrameForwardingClient
  }
}
