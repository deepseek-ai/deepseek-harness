/** Replay-stable view models for Cordis lifecycle Tool calls. */

import type { StartedToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, CordisDynamicRunMode,
} from './events.ts'

type Block = StartedToolCallViewProps['block']

/** Lifecycle of the tool call itself. */
export type CordisToolState = 'running' | 'ok' | 'error' | 'stopped'

/** Frozen `cordis_define` presentation data. */
export interface CordisDefineCard {
  readonly pluginId: CordisDynamicPluginId | null
  readonly packageId: CordisDynamicPackageId | null
  readonly name: string | null
  readonly purpose: string | null
  readonly hostCode: string | null
  readonly clientCode: string | null
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: CordisToolState
}

/** Frozen `cordis_run` presentation data. */
export interface CordisRunCard {
  readonly pluginId: CordisDynamicPluginId | null
  readonly packageId: CordisDynamicPackageId | null
  readonly pluginRunId: CordisDynamicPluginRunId | null
  readonly mode: CordisDynamicRunMode | null
  readonly seq: number | null
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: CordisToolState
}

/** Frozen `cordis_stop` or `cordis_undefine` presentation data. */
export interface CordisActionCard {
  readonly pluginId: CordisDynamicPluginId | null
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: CordisToolState
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function stringAt(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function objectAt(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key]
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function parseArgs(argsRaw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    // Running calls can expose a truncated JSON prefix.
    return null
  }
}

function resultText(block: Extract<Block, { kind: 'tool-result' }>): string | null {
  const text = block.content
    .map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
    .join('\n')
  if (text !== '') return text
  return block.error === undefined ? null : `${block.error.name}: ${block.error.code}`
}

function stateOf(block: Block): CordisToolState {
  if (!('kind' in block)) return 'running'
  if (block.error?.code === 'interrupted') return 'stopped'
  return block.isError ? 'error' : 'ok'
}

function metaObject(block: Block): Record<string, unknown> | null {
  if (!('kind' in block) || block.isError || typeof block.meta !== 'object' || block.meta === null) return null
  return block.meta as Record<string, unknown>
}

/**
 * Derive one Define card from its frozen call/result slice.
 * @param block - active or settled tool-call block.
 * @returns normalized Define card fields.
 */
export function cordisDefineCard(block: Block): CordisDefineCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const code = args === null ? null : objectAt(args, 'code')
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  const meta = metaObject(block)
  const rawName = argsRaw === '' ? null : firstLine(argsRaw)
  return {
    pluginId: meta === null ? null : stringAt(meta, 'pluginId') as CordisDynamicPluginId | null,
    packageId: meta === null ? null : stringAt(meta, 'packageId') as CordisDynamicPackageId | null,
    name: args === null ? rawName : stringAt(args, 'name') ?? rawName,
    purpose: args === null ? null : stringAt(args, 'purpose'),
    hostCode: code === null ? null : stringAt(code, 'host'),
    clientCode: code === null ? null : stringAt(code, 'client'),
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/**
 * Derive one Run card and its successful activation metadata.
 * @param block - active or settled tool-call block.
 * @returns normalized Run card fields.
 */
export function cordisRunCard(block: Block): CordisRunCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const meta = metaObject(block)
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  const rawMode = args === null ? null : stringAt(args, 'mode')
  const argsPluginId = args === null ? null : stringAt(args, 'pluginId')
  const argsPackageId = args === null ? null : stringAt(args, 'packageId')
  return {
    pluginId: (meta === null ? argsPluginId : stringAt(meta, 'pluginId') ?? argsPluginId) as CordisDynamicPluginId | null,
    packageId: (meta === null ? argsPackageId : stringAt(meta, 'packageId') ?? argsPackageId) as CordisDynamicPackageId | null,
    pluginRunId: (meta === null ? null : stringAt(meta, 'pluginRunId')) as CordisDynamicPluginRunId | null,
    mode: rawMode === 'run' || rawMode === 'update' ? rawMode : null,
    seq: settled ? block.seq : null,
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/**
 * Derive one Stop or Remove card from its frozen call/result slice.
 * @param block - active or settled tool-call block.
 * @returns normalized lifecycle-action card fields.
 */
export function cordisActionCard(block: Block): CordisActionCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  return {
    pluginId: (args === null ? null : stringAt(args, 'pluginId') ?? stringAt(args, 'id')) as CordisDynamicPluginId | null,
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}
