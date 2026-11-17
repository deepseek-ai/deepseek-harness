import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Adapter, setup } from './fixture.ts'

describe('Timeline persistence across built Host processes', () => {
  it('refuses a competing process and restores acknowledged saves after the writer is killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-timeline-process-'))
    const sessionId = SessionId('timeline-process-recovery')
    const start = (mode: string) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./host-process.mjs', import.meta.url)), mode, root, sessionId], {
        cwd: process.cwd(),
        env: {},
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const closed = once(child, 'close')
      let output = ''
      let errors = ''
      child.stdout.setEncoding('utf8').on('data', (text: string) => {
        output = (output + text).slice(-8192)
      })
      child.stderr.setEncoding('utf8').on('data', (text: string) => {
        errors = (errors + text).slice(-8192)
      })
      const ready = async (line: string) => {
        const signal = AbortSignal.timeout(5000)
        while (!output.includes(`${line}\n`)) {
          if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}: ${errors}`)
          await Promise.race([
            once(child.stdout, 'data', { signal }),
            closed.then(() => {
              throw new Error(`Host closed before ${line}: ${errors}`)
            }),
          ])
        }
      }
      return { child, closed, ready }
    }
    const owner = start('commit')
    try {
      await owner.ready('committed')
      const competitor = start('compete')
      try {
        await competitor.ready('owned')
        expect((await competitor.closed)[0]).toBe(0)
      } finally {
        competitor.child.kill('SIGKILL')
        await competitor.closed
      }
      owner.child.kill('SIGKILL')
      expect((await owner.closed)[1]).toBe('SIGKILL')
      const recovered = await setup({ intervalMs: 86400000 }, new Adapter(), { root, sessionId })
      try {
        const view = recovered.ctx.timeline.stateOf(recovered.agent.session).view
        expect(view.trees[0]?.tasks[0]?.done).toEqual([2, 3])
        expect(view.annotations[0]).toMatchObject({
          text: 'Retain the completed checks.',
          reply: { text: 'Two checks are saved.' },
        })
        expect(recovered.adapter.checks).toHaveLength(0)
      } finally {
        await recovered.close({ preserve: true })
      }
    } finally {
      owner.child.kill('SIGKILL')
      await owner.closed
      await rm(root, { recursive: true, force: true })
    }
  })
})
