import { describe, expect, it } from 'vitest'
import { EVENT_API, queryServiceApi, SERVICE_API } from '../src/client/api-catalog.ts'

describe('Client Cordis inspect catalog', () => {
  it('publishes the split Workspace Controller and UI navigation services', () => {
    expect(SERVICE_API.find(service => service.key === 'layout')?.methods.map(method => method.signature))
      .toEqual([
        'selectPanel(panelId: MainPanelId | null): void',
        'beginNavigation(): AbortSignal',
        'toggleSidebar(): void',
        'openRightbar(track: boolean, fullscreen: boolean): void',
        'closeRightbar(): void',
      ])
    expect(SERVICE_API.find(service => service.key === 'workspaces')?.methods.map(method => method.signature))
      .toEqual([
        'create(input: { path: string }): Promise<WorkspaceView>',
        'rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>',
        'delete(workspaceId: WorkspaceId): Promise<void>',
        'archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>',
        'unarchiveSession(sessionId: SessionId): Promise<void>',
        'insertSessionBefore( workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId, ): Promise<WorkspaceView>',
      ])
    expect(SERVICE_API.find(service => service.key === 'uiWorkspace')?.methods.map(method => method.signature))
      .toEqual([
        'openSession(target: SessionTarget): void',
        'openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void>',
        'forkSession( sessionId: SessionId, onCreated?: (childId: SessionId) => void, options?: Pick<Parameters<ISessions[\'fork\']>[0], \'allowMigration\'>, ): Promise<SessionId>',
        'connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>',
        'startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions): void',
        'archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>',
        'unarchiveSession(sessionId: SessionId): Promise<void>',
        'pickDirectory(): Promise<string | null>',
        'listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>',
        'createDirectory(path: string, name: string): Promise<string>',
      ])
  })

  it('contains one entry per visible Client event', () => {
    const names = EVENT_API.map(event => event.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('describes text-only draft initialization in Workspace navigation', () => {
    const result = queryServiceApi('uiWorkspace') as {
      referencedTypes: readonly { name: string; declaration: string }[]
    }
    expect(result.referencedTypes.find(type => type.name === 'StartSessionOptions')?.declaration)
      .toContain('DraftInitializationOptions')
    expect(result.referencedTypes.find(type => type.name === 'DraftInitializationOptions')?.declaration)
      .toContain('readonly prompt?: string')
    expect(result.referencedTypes.find(type => type.name === 'DraftInitializationOptions')?.declaration)
      .toContain('readonly clearPreviousDraft?: boolean')
    expect(result.referencedTypes.map(type => type.name)).not.toEqual(expect.arrayContaining([
      'DraftInput', 'DraftSnapshot', 'DraftReference',
    ]))
  })

  it('includes the current referenced type closure for the Sessions service', () => {
    const result = queryServiceApi('sessions') as {
      referencedTypes: readonly { name: string; declaration: string }[]
    }
    expect(result.referencedTypes.length).toBeGreaterThan(0)
    const promptContentPart = result.referencedTypes.find(type => type.name === 'PromptContentPart')
    expect(promptContentPart?.declaration).toContain("readonly type: 'image'")
    expect(result.referencedTypes.map(type => type.name)).not.toEqual(expect.arrayContaining([
      'ConversationSnapshot',
      'PendingInteraction',
      'PendingPayloads',
      'PendingWait',
    ]))
  })
})
