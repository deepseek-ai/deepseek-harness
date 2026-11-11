// @vitest-environment jsdom
/** Plugins that render `useSessionStatus` follow the status table's plugin lifecycle in the real Loader and renderer. */
import { act } from '@testing-library/react'
import { expect, onTestFinished, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

const STATUS = '@deepseek-ai/dsh-client-ui-session-status'
const WORKSPACE = '@deepseek-ai/dsh-client-ui-workspace'
const CONVERSATION = '@deepseek-ai/dsh-client-ui-conversation'

const it = createClientTest({ roster: webApp.closure([WORKSPACE, CONVERSATION]) }, { mount: true })

it('unloads hook consumers with the status table and renders them again after it reloads', async ({ start }) => {
  const errors = vi.spyOn(console, 'error')
  onTestFinished(() => { errors.mockRestore() })
  const client = await start()
  const entry = (name: string) => [...client.ctx.loader.entries()].find(candidate => candidate.options.name === name)
  // Each consumer provides its own service only while its plugin is active.
  const consumers = () => [client.ctx.get('uiWorkspace') !== undefined, client.ctx.get('uiConversation') !== undefined]
  const slotText = (name: string) => client.container!.querySelector(`[data-slot="${name}"]`)?.textContent ?? ''
  const status = entry(STATUS)
  if (status === undefined) throw new Error(`${STATUS} is not in the roster`)

  expect(consumers()).toEqual([true, true])
  expect(slotText('sidebar.workspaces')).toContain('Workspaces')
  expect(slotText('main.conversation')).toContain('Choose a workspace to start')

  await act(async () => { await status.update({ disabled: true }) })
  await client.flush()

  expect(consumers()).toEqual([false, false])
  expect(slotText('sidebar.workspaces')).not.toContain('Workspaces')
  expect(slotText('main.conversation')).not.toContain('Choose a workspace to start')

  await act(async () => { await status.update({ disabled: false }) })
  await client.flush()

  expect(consumers()).toEqual([true, true])
  expect(slotText('sidebar.workspaces')).toContain('Workspaces')
  expect(slotText('main.conversation')).toContain('Choose a workspace to start')
  expect(errors).not.toHaveBeenCalled()
}, 60_000)
