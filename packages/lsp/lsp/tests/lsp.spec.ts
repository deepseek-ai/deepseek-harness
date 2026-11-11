import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import Lsp, {
  finalExtension,
  LspError,
  type LspProviderId,
  type LspProvider,
  type LspProviderQuery,
  type LspQueryResult,
} from '@deepseek-ai/dsh-lsp'

/** A scripted provider that records the queries it receives. */
function makeProvider(
  id: string,
  extensionToLanguage: Record<string, string>,
  result: LspQueryResult = { kind: 'locations', locations: [], resolvedWorkspaceUri: 'file:///ws' },
): LspProvider & { seen: LspProviderQuery[]; seenSignals: (AbortSignal | undefined)[] } {
  const seen: LspProviderQuery[] = []
  const seenSignals: (AbortSignal | undefined)[] = []
  return {
    id: brandString<LspProviderId>(id),
    extensionToLanguage,
    seen,
    seenSignals,
    query(request, signal) {
      seen.push(request)
      seenSignals.push(signal)
      return Promise.resolve(result)
    },
  }
}

/** Mount an Lsp service on a fresh root context. */
async function mountLsp(): Promise<{ ctx: Context; lsp: Lsp }> {
  const ctx = new Context()
  await ctx.plugin(Lsp)
  return { ctx, lsp: ctx.lsp as Lsp }
}

const hover: LspQueryResult = { kind: 'hover', hover: { contents: 'x' } }

function query(filePath: string, operation: LspProviderQuery['operation'] = 'goToDefinition'): Parameters<Lsp['query']>[0] {
  return { operation, filePath, position: { line: 0, character: 0 }, workspaceRoot: '/ws' }
}

describe('finalExtension', () => {
  it('lowercases and keeps only the final extension', () => {
    expect(finalExtension('src/Foo.TS')).toBe('.ts')
    expect(finalExtension('a/b/foo.d.ts')).toBe('.ts')
    expect(finalExtension('C:\\proj\\Main.CS')).toBe('.cs')
  })

  it('returns empty for no extension or a leading-dot dotfile', () => {
    expect(finalExtension('Makefile')).toBe('')
    expect(finalExtension('.bashrc')).toBe('')
    expect(finalExtension('dir.d/file')).toBe('')
  })
})

describe('Lsp registration', () => {
  it('registers a provider and routes a query to it, then releases on dispose', async () => {
    const { lsp } = await mountLsp()
    const provider = makeProvider('ts', { '.ts': 'typescript' })
    const dispose = lsp.registerProvider(provider)

    await expect(lsp.query(query('a.ts'))).resolves.toEqual({ kind: 'locations', locations: [], resolvedWorkspaceUri: 'file:///ws' })
    expect(provider.seen[0]).toMatchObject({ filePath: 'a.ts', languageId: 'typescript' })

    dispose()
    await expect(lsp.query(query('a.ts'))).rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
  })

  it('normalizes extension keys to lowercase leading-dot and derives the language id', async () => {
    const { lsp } = await mountLsp()
    const provider = makeProvider('ts', { TS: 'typescript' })
    lsp.registerProvider(provider)
    await lsp.query(query('a.ts'))
    expect(provider.seen[0]?.languageId).toBe('typescript')
  })

  it('rejects an empty provider id (LSP_INVALID_PROVIDER)', async () => {
    const { lsp } = await mountLsp()
    expect(() => lsp.registerProvider(makeProvider('  ', { '.ts': 'typescript' })))
      .toThrow(expect.objectContaining({ code: 'LSP_INVALID_PROVIDER' }))
  })

  it('rejects a provider with no extensions (LSP_INVALID_PROVIDER)', async () => {
    const { lsp } = await mountLsp()
    expect(() => lsp.registerProvider(makeProvider('ts', {})))
      .toThrow(expect.objectContaining({ code: 'LSP_INVALID_PROVIDER' }))
  })

  it('rejects an invalid extension mapping (LSP_INVALID_PROVIDER)', async () => {
    const { lsp } = await mountLsp()
    expect(() => lsp.registerProvider(makeProvider('ts', { '.tar.gz': 'archive' })))
      .toThrow(expect.objectContaining({ code: 'LSP_INVALID_PROVIDER' }))
  })

  it('rejects an empty language id (LSP_INVALID_PROVIDER)', async () => {
    const { lsp } = await mountLsp()
    expect(() => lsp.registerProvider(makeProvider('ts', { '.ts': '  ' })))
      .toThrow(expect.objectContaining({ code: 'LSP_INVALID_PROVIDER' }))
  })

  it('rejects an extension mapped twice within one provider (LSP_INVALID_PROVIDER)', async () => {
    const { lsp } = await mountLsp()
    expect(() => lsp.registerProvider(makeProvider('ts', { '.ts': 'typescript', TS: 'ts2' })))
      .toThrow(expect.objectContaining({ code: 'LSP_INVALID_PROVIDER' }))
  })

  it('rejects a duplicate provider id (LSP_CONFLICT)', async () => {
    const { lsp } = await mountLsp()
    lsp.registerProvider(makeProvider('ts', { '.ts': 'typescript' }))
    expect(() => lsp.registerProvider(makeProvider('ts', { '.tsx': 'typescriptreact' })))
      .toThrow(expect.objectContaining({ code: 'LSP_CONFLICT' }))
  })

  it('rejects an extension already owned by another provider (LSP_CONFLICT)', async () => {
    const { lsp } = await mountLsp()
    lsp.registerProvider(makeProvider('ts', { '.ts': 'typescript' }))
    expect(() => lsp.registerProvider(makeProvider('other', { '.ts': 'other-lang' })))
      .toThrow(expect.objectContaining({ code: 'LSP_CONFLICT' }))
  })

  it('publishes nothing when a later extension conflicts (atomic reservation)', async () => {
    const { lsp } = await mountLsp()
    lsp.registerProvider(makeProvider('ts', { '.ts': 'typescript' }))
    // This provider's `.py` is free but `.ts` conflicts: the whole registration must roll back.
    expect(() => lsp.registerProvider(makeProvider('py-ts', { '.py': 'python', '.ts': 'x' })))
      .toThrow(expect.objectContaining({ code: 'LSP_CONFLICT' }))
    // `.py` must NOT have been reserved.
    await expect(lsp.query(query('a.py'))).rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
  })

  it('releases every extension and the id together on dispose', async () => {
    const { lsp } = await mountLsp()
    const dispose = lsp.registerProvider(makeProvider('multi', { '.ts': 'typescript', '.tsx': 'typescriptreact' }))
    dispose()
    await expect(lsp.query(query('a.ts'))).rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
    await expect(lsp.query(query('a.tsx'))).rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
    // The id is free again after release.
    expect(() => lsp.registerProvider(makeProvider('multi', { '.ts': 'typescript' }))).not.toThrow()
  })

  it('selection is order-independent across two providers', async () => {
    const { lsp } = await mountLsp()
    const ts = makeProvider('ts', { '.ts': 'typescript' }, hover)
    const py = makeProvider('py', { '.py': 'python' })
    lsp.registerProvider(ts)
    lsp.registerProvider(py)
    await expect(lsp.query(query('a.py'))).resolves.toEqual({ kind: 'locations', locations: [], resolvedWorkspaceUri: 'file:///ws' })
    await expect(lsp.query(query('a.ts', 'hover'))).resolves.toEqual(hover)
  })

  it('forwards the abort signal verbatim to the provider', async () => {
    const { lsp } = await mountLsp()
    const provider = makeProvider('ts', { '.ts': 'typescript' })
    lsp.registerProvider(provider)
    const controller = new AbortController()
    await lsp.query(query('a.ts'), controller.signal)
    expect(provider.seenSignals[0]).toBe(controller.signal)
  })

  it('fails LSP_UNAVAILABLE when no provider handles the extension', async () => {
    const { lsp } = await mountLsp()
    lsp.registerProvider(makeProvider('ts', { '.ts': 'typescript' }))
    await expect(lsp.query(query('a.py'))).rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, lsp } = await mountLsp()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.lsp.registerProvider(makeProvider('ts', { '.ts': 'typescript' }))
    }, { inject: ['lsp'] }))
    await expect(lsp.query(query('a.ts'))).resolves.toEqual({ kind: 'locations', locations: [], resolvedWorkspaceUri: 'file:///ws' })
    await fiber.dispose()
    await expect(lsp.query(query('a.ts'))).rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
  })

  it('LspError carries its structured code', () => {
    expect(new LspError('m', 'LSP_UNAVAILABLE').code).toBe('LSP_UNAVAILABLE')
  })

  it('brands a provider id without altering the string', () => {
    expect(brandString<LspProviderId>('ts')).toBe('ts')
  })
})
