// @vitest-environment jsdom
/** Desktop directory flow through the Web bundle roster and production client boot. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ClientRoster, createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
  name: string
  dsh: { client: { inject: string[] } }
}
// Auto mounts the native row dynamically; use that package's actual dependency declaration.
const test = createClientTest({ roster: ClientRoster.of([...webApp.rows, {
  name: manifest.name, inject: manifest.dsh.client.inject, immediately: false,
}]) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('the composed native flow cancels through Desktop without invoking the Host chooser', async ({ start, remote }) => {
  const pick = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
  vi.stubGlobal('__DSH_DIRECTORY_PICKER__', { pick })
  const client = await start()
  const entry = client.ctx.slots.entries('sidebar.workspaces.directoryFlow')[0]!
  const injected = (entry.inject as () => { pick: () => Promise<string | null> })()
  const Component = entry.component as ComponentType<DirectoryFlowOwnerProps & typeof injected>
  const onCancel = vi.fn()
  render(<Component {...injected} open busy={false} onCancel={onCancel} onPicked={vi.fn()} onError={vi.fn()} />)
  await waitFor(() => { expect(onCancel).toHaveBeenCalledOnce() })
  expect(pick).toHaveBeenCalledOnce()
  expect(remote.directoryPicker.pick).not.toHaveBeenCalled()
}, 60_000)
