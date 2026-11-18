import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { EVENT_API, SERVICE_API, TYPE_API } from '@deepseek-ai/dsh-tool-cordis/src/api-catalog.ts'
import { WorkspaceAnalyzer } from '../src/analyzer.ts'
import { FaceModelEmitter } from '../src/emitter.ts'

const workspaceRoot = resolve(import.meta.dirname, '../../../..')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('model-driven tool package generation', () => {
  it('round-trips the complete service and event structure through the runtime registry', { timeout: 30_000 }, async ({ onTestFinished }) => {
    const workspace = new WorkspaceAnalyzer({
      root: workspaceRoot,
      faces: ['host'],
      packages: ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-ptc'],
    }).analyze()
    const host = workspace.faces.find(candidate => candidate.face === 'host')
    if (host === undefined) throw new Error('dsh-tools has no analyzed host face')
    const root = mkdtempSync(join(import.meta.dirname, '.generated-tools-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(TypertRegistry)
    const registry = ctx.typert
    for (const name of ['tools', 'tool-executor-ptc']) {
      const artifact = new FaceModelEmitter(host).emit(`@deepseek-ai/dsh-${name}`)
      const modulePath = join(root, `${name}.mjs`)
      writeFileSync(modulePath, artifact.js)
      const generated = await import(pathToFileURL(modulePath).href) as { TYPERT: TypertContribution }
      registry.register(generated.TYPERT)
    }
    const record = ctx.typert.getPackage('@deepseek-ai/dsh-tools', 'host')
    const executor = ctx.typert.getPackage('@deepseek-ai/dsh-tool-executor-ptc', 'host')
    expect(executor?.model.events.map(event => event.name)).toEqual(['tools/ptc-dispatch-log'])
    const service = record?.model.services.find(candidate => candidate.key === 'tools')
    expect(service).toBeDefined()
    expect({
      key: service?.key,
      summary: service?.summary,
      methods: service?.members
        .filter(member => member.kind === 'method' && !member.name.startsWith('['))
        .map(member => member.signature),
    }).toEqual((() => {
      const api = SERVICE_API.find(candidate => candidate.key === 'tools')
      return {
        key: api?.key,
        summary: api?.summary,
        methods: api?.methods.map(method => method.signature),
      }
    })())
    const events = [...record?.model.events ?? [], ...executor?.model.events ?? []]
      .filter(event => event.name.startsWith('tools/'))
      .sort((a, b) => a.name.localeCompare(b.name))
    expect(events.map(event => ({
      name: event.name,
      mode: event.mode,
      signature: event.signature,
      summary: event.summary,
    }))).toEqual(EVENT_API.filter(event => event.name.startsWith('tools/')).map(event => ({
      name: event.name,
      mode: event.mode,
      signature: event.signature,
      summary: event.summary,
    })))
    expect(service?.types.find(type => type.name === 'ToolDefinition')).toEqual(
      TYPE_API.find(type => type.name === 'ToolDefinition'),
    )

    await ctx.fiber.dispose()
    expect(registry.getPackage('@deepseek-ai/dsh-tools', 'host')).toBeUndefined()
    expect(registry.getPackage('@deepseek-ai/dsh-tool-executor-ptc', 'host')).toBeUndefined()
  })
})
