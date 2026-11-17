import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { AUTO_PRESET, type PermissionPresetSetRequest } from '@deepseek-ai/dsh-permission-presets'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, onTestFinished } from 'vitest'
import { callResources } from '../../../api/gateway/src/access.ts'
import { resolveSessionResource } from '../../../api/session-controller/src/session-resource.ts'
import PermissionPresetService from '../src/index.ts'

/** The `set` request as the client sends it, named arguments and preset. */
function setRequest(sessionId: SessionId): PermissionPresetSetRequest {
  return { sessionId, preset: AUTO_PRESET }
}

async function mounted(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(TypertRegistry)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('resource tests do not execute shell commands') },
    run() { throw new Error('resource tests do not execute shell commands') },
    start() { throw new Error('resource tests do not execute shell commands') },
  })
  ctx.provide('approval', { config: { policy: 'ask' } })
  await ctx.plugin(PermissionPresetService, {})
  return ctx
}

/**
 * Install the Session Controller's own `session` resource default with the
 * resolver it registers. Mounting the whole Session Controller would drag its
 * entire dependency web into this harness, while this registration is the one
 * Host-side step that names the resource; the controller's own suite covers
 * the rest of it.
 * @param ctx - context holding the live Typert registry.
 */
function installSessionResolver(ctx: Context): void {
  ctx.typert.resources.register('session', { resolve: resolveSessionResource })
}

/**
 * The resources the Gateway resolves for one `set` call: the readers the live
 * Service declares, the registry they resolve against, and the call's named
 * arguments.
 * @param ctx - context holding the mounted Service and Typert registry.
 * @param request - the call's single JSON argument.
 * @returns the resolved resources, or `undefined` when they are invalid.
 */
function setResources(
  ctx: Context,
  request: PermissionPresetSetRequest,
): ReturnType<typeof callResources> {
  const descriptor: Pick<InvocationDescriptor, 'invocation' | 'parameters'> = {
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }],
  }
  const readers = remoteMethods(ctx.permissionPresets).find(marker => marker.method === 'setPreset')?.resources
  return callResources(ctx.typert, readers, descriptor, { request }, new AbortController().signal)
}

describe('permissionPresets/set Session resource', () => {
  it('exports the set endpoint without a reader of its own', async () => {
    const ctx = await mounted()
    const marker = remoteMethods(ctx.permissionPresets).find(candidate => candidate.method === 'setPreset')
    expect(marker?.exportName).toBe('set')
    // The Session Controller's resolver names this call's Session; a reader here
    // would restate that rule and hide its source.
    expect(marker?.resources?.session).toBeUndefined()
  })

  it('resolves the call to the Session it names through the Session Controller resolver', async () => {
    const ctx = await mounted()
    installSessionResolver(ctx)
    const session = Session.create(brandString<SessionId>('sess-resource'))
    expect(setResources(ctx, setRequest(session.id))).toEqual([{ kind: 'session', id: session.id }])
  })

  it('resolves the call to the global resource without a resolver', async () => {
    // The counterpart above: `set` declares no reader, so without the Session
    // Controller's resolver the Gateway has nothing that names the Session.
    const ctx = await mounted()
    const session = Session.create(brandString<SessionId>('sess-resource'))
    expect(setResources(ctx, setRequest(session.id))).toEqual([{ kind: 'global' }])
  })
})
