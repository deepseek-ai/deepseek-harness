// @vitest-environment jsdom
import { act } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { TestClient, remoteDefaultResponses, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

describe('assembled renderer connection recovery', () => {
  it('keeps the mounted root across a transport reconnect', async () => {
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const client = await TestClient.start({ roster: webApp }, mock, { mount: true })
    onTestFinished(() => client.dispose())
    const root = client.container!.querySelector('[data-slot="root"]')
    const generation = client.connection.generation.getSnapshot()!.id
    expect(root).not.toBeNull()

    await act(async () => {
      client.connection.reconnect()
      await vi.waitFor(() => {
        expect(client.connection.generation.getSnapshot()?.id).toBeGreaterThan(generation)
        expect(client.connection.state.getSnapshot()).toBe('connected')
      })
    })

    expect(client.container!.querySelector('[data-slot="root"]')).toBe(root)
  }, 60_000)
})
