/** Deterministic terminal controller for the terminal panel snapshot: one terminal the user opened, showing an error. */

const terminal = {
  id: 'user-terminal-1', shell: { name: 'zsh', path: '/bin/zsh', args: ['-i'] }, title: 'zsh', cwd: '/workspace/app',
  rows: 24, cols: 80, state: 'running', exitCode: null, origin: 'user', control: 'user',
}
const screen = ['$ pnpm test', "Error: Cannot find module 'vitest'", '$']

/** Cordis plugin name. */
export const name = 'terminal-controller-fixture'

/** Provide the controller operations the user-terminal tools read. */
export function apply(ctx) {
  ctx.provide('terminalController', {
    list: () => [terminal],
    inspectActivity: () => Promise.resolve('idle'),
    readScreen: (_agent, _id, request) => {
      const end = Math.max(0, screen.length - request.offset)
      const lines = screen.slice(Math.max(0, end - request.count), end)
      return Promise.resolve({
        text: lines.join('\n'), totalLines: screen.length, lineBegin: request.offset, lineEnd: request.offset + lines.length, truncated: false,
      })
    },
  })
}
