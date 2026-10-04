/** Scripted terminal frames exercise the real persistent PowerShell tool and Session log. */

const responses = [
  { token: 'PWSH_OK', code: 0 },
  { token: 'PWSH_FAIL', code: 7 },
]

class SnapshotSession {
  motd = 'dsh> '
  statusValue = { kind: 'running' }
  scrollback = 'dsh> '
  next = 0

  startSend(request) {
    const response = responses[this.next++]
    if (!response || !request.submit || !request.text.includes(`[Console]::Out.Write('  ${response.token}  ')`)) {
      throw new Error('unexpected padded-completion snapshot command')
    }
    const start = /__DSH_PERSISTENT_PWSH_START_[a-f0-9-]+__/.exec(request.text)?.[0]
    const end = /__DSH_PERSISTENT_PWSH_END_[a-f0-9-]+:/.exec(request.text)?.[0]
    if (!start || !end) throw new Error('padded-completion snapshot requires the actual command markers')
    const viewport = `${request.text}\r\n${start}\r\n  ${response.token}  ${end}${response.code}  \r\n${this.motd}`
    this.scrollback += viewport
    const result = { viewport, waitReason: 'stdin_read', sessionStatus: this.statusValue, truncated: false }
    let consumed = false
    return {
      done: Promise.resolve(result),
      readOutput: () => {
        if (consumed) return { delta: '', truncated: false }
        consumed = true
        return { delta: viewport, truncated: false }
      },
      cancel: () => false,
    }
  }

  read(request) {
    const lines = this.scrollback.split('\n')
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    const end = lines.length - offset
    const start = Math.max(0, end - count)
    const text = lines.slice(start, end).join('\n')
    return { text, totalLines: lines.length, lineBegin: offset, lineEnd: offset + text.split('\n').length, truncated: false }
  }

  signal() {
    return Promise.resolve({ delivered: true, targetPgid: 1 })
  }

  status() {
    return this.statusValue
  }

  close() {
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
    return Promise.resolve()
  }
}

/** Scenario-local fixture identity. */
export const name = 'pwsh-padded-completion-snapshot'
/** Terminal service owns the backend registration and sessions. */
export const inject = ['terminals']

/** Register deterministic completion frames under the real terminal service. @param ctx - Effect-scoped plugin context. */
export function apply(ctx) {
  ctx.terminals.registerBackend({
    type: 'shell',
    spawn: () => Promise.resolve(new SnapshotSession()),
  })
}
