/** Compile-time registration checks for local state inference and client view declarations. */
import { expectTypeOf } from 'vitest'
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'type-test/label': { label: string }
  }
}

const counter = {
  key: 'type-test/counter',
  stateSchema: z.number(),
  stateVersion: 1,
  init: () => 0,
  apply: state => state + 1,
} satisfies ProjectionDefinition<'type-test/counter', number>

/**
 * Check inference and invalid registrations without executing them.
 * @param registry - public projection registry.
 * @param session - Session used to typecheck retained reads.
 * @returns after the typechecked registration calls.
 */
export async function checkProjectionRegistrationTypes(registry: SessionProjectionRegistry, session: Session): Promise<void> {
  const host = await registry.register(counter)
  expectTypeOf(host).toEqualTypeOf<ProjectionHandle<number>>()
  expectTypeOf(host.stateOf(session)).toEqualTypeOf<number>()

  const nullable = await registry.register({
    key: 'type-test/nullable',
    stateSchema: z.string().nullable(),
    stateVersion: 1,
    init: () => null,
    apply: (state) => {
      expectTypeOf(state).toEqualTypeOf<string | null>()
      return state
    },
  })
  expectTypeOf(nullable.stateOf(session)).toEqualTypeOf<string | null>()

  const visible = {
    ...counter,
    key: 'type-test/label' as const,
    wire: {
      viewSchema: z.object({ label: z.string() }),
      view: (state: number) => ({ label: String(state) }),
    },
  }
  const client = await registry.register(visible)
  expectTypeOf(client.stateOf(session)).toEqualTypeOf<number>()

  // @ts-expect-error -- initial state must match the state schema.
  void registry.register({ ...counter, init: () => 'wrong' })
  // @ts-expect-error -- fold results must match the state schema.
  void registry.register({ ...counter, apply: () => 'wrong' })
  // @ts-expect-error -- a declared client key requires its view.
  void registry.register({ ...counter, key: 'type-test/label' })

  const wrongView = { ...visible, wire: { ...visible.wire, view: (state: number) => ({ label: state }) } }
  // @ts-expect-error -- the view must match the client key's declared value.
  void registry.register(wrongView)
  const unknownView = { ...visible, key: 'type-test/undeclared-view' as const }
  // @ts-expect-error -- client-visible keys must be declared in the client map.
  void registry.register(unknownView)
}
