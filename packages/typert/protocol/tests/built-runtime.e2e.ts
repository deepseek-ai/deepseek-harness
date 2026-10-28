import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it.each(['../lib/index.js', '../lib/types/remote-info.js'])(
  'keeps the published protocol entry %s free of Zod runtime imports',
  async (entry) => {
    const source = await readFile(new URL(entry, import.meta.url), 'utf8')
    expect(source).not.toMatch(/\b(?:from|import|require)\s*(?:\(\s*)?['"]zod(?:\/[^'"]*)?['"]/)
  },
)

it('recognizes source and built Cordis Contexts in an active built RemoteAccess plugin', () => {
  const script = `
    import { Context as SourceContext } from '@deepseek-ai/cordis/src/index.ts'
    import { Context as BuiltContext } from '@deepseek-ai/cordis'
    import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'

    const observations = []
    for (const [copy, Context] of [['source', SourceContext], ['built', BuiltContext]]) {
      const root = new Context()
      let observed
      try {
        await root.plugin({ apply(ctx) {
          const access = new RemoteAccess(ctx)
          const guestInvocation = {
            request: { namespace: 'session', method: 'search', args: {} },
            peer: { principal: { kind: 'guest' } },
          }
          const guest = ctx.extend({ invocation: guestInvocation })
          observed = {
            copy,
            sameConstructor: ctx instanceof BuiltContext,
            recognized: BuiltContext.is(ctx),
            active: !!ctx.fiber.runtime,
            accessor: Object.hasOwn(root.reflect.props, 'invocation'),
            outside: ctx.invocation ?? null,
            allowsOutside: access.ctx.remoteAccess.allows({ kind: 'global' }),
            preservedGuest: guest.invocation === guestInvocation,
            allowsGuest: guest.remoteAccess.allows({ kind: 'global' }),
          }
        } })
        observations.push(observed)
      } finally {
        await root.fiber.dispose()
      }
    }
    console.log(JSON.stringify(observations))
  `
  const output = execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
    cwd: new URL('../../../api/remote-access/', import.meta.url),
    encoding: 'utf8',
    timeout: 15_000,
  })
  expect(JSON.parse(output)).toEqual([
    { copy: 'source', sameConstructor: false, recognized: true, active: true, accessor: true,
      outside: null, allowsOutside: true, preservedGuest: true, allowsGuest: false },
    { copy: 'built', sameConstructor: true, recognized: true, active: true, accessor: true,
      outside: null, allowsOutside: true, preservedGuest: true, allowsGuest: false },
  ])
})
