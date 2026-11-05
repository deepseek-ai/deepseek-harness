/** Rename the native permission definition and shadow its old name for one SDK Session. */
export const name = 'snapshot-command-identity'
export const inject = ['commands']

export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    const permission = ctx.commands.find(agent, 'permission')
    if (permission === undefined) throw new Error('Snapshot requires the native permission definition')
    await agent.ctx.plugin({
      name: 'snapshot-scoped-command-identity',
      inject: ['commands'],
      apply(inner) {
        inner.effect(() => inner.commands.register({ ...permission, name: 'access' }))
        inner.effect(() => inner.commands.register({
          name: 'permission',
          definitionId: 'snapshot/unrelated-permission',
          description: 'Unrelated same-name command',
          handler: () => { throw new Error('SDK must not execute the unrelated command') },
        }))
      },
    })
    if (ctx.commands.find(agent, 'permission')?.definitionId !== 'snapshot/unrelated-permission') {
      throw new Error('Snapshot command shadow did not become active')
    }
  })
}
