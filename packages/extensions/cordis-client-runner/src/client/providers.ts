/** Built-in Client inspect providers over live Client-owned services. */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { queryEventApi, queryServiceApi } from './api-catalog.ts'
import type { ClientCordisInspectProviderRegistration } from './inspect-registry.ts'
import { CLIENT_SLOT_API } from './slot-catalog.ts'
import type { ClientSlotEntry } from './slot-catalog.ts'

/* jscpd:ignore-start */
const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const
const ANY_OUTPUT = { description: 'JSON data owned by this inspect provider.' } as const
const SERVICE_INPUT = exactInput('service', 'Exact Service key. Omit it for the compact Service and method-signature directory.')
const EVENT_INPUT = exactInput('event', 'Exact Event name. Omit it for the compact Event and listener-signature directory.')
const SERVICE_OUTPUT = {
  description: 'Compact Service directory, or one exact Service contract with only its referenced type declarations.',
} as const
const EVENT_OUTPUT = {
  description: 'Compact Event directory, or one exact Event contract with only its referenced type declarations.',
} as const
/* jscpd:ignore-end */
const SUBTREE_OUTPUT = {
  description: 'Compact topology trees. An exact Slot includes its catalog and occupants; an exact Factory includes identity, scope, and registrant.',
} as const
const SUBTREE_INPUT = {
  type: 'object',
  properties: {
    root: {
      type: 'string',
      description: 'Exact live Slot key or factory:<name>. When supplied, selected contains that declaration.',
    },
  },
  additionalProperties: false,
} as const

/** Exact Client closure symbols exposed by the evaluator and guard. */
export const CLIENT_BUILTIN_INSPECTION: readonly JsonValue[] = [
  {
    name: 'ctx',
    description: 'Restricted Cordis Context. Prefer ctx.get(name) with an undefined check; use inject only for hard dependencies.',
    signatures: [
      'ctx.get(name: string): unknown | undefined',
      'ctx.on(name: string, listener: Function): () => void',
      'ctx.provide(name: string, value: unknown): () => void',
      'ctx.effect(callback: Function, label?: string): () => void',
    ],
  },
  {
    name: 'React',
    description: 'React runtime exposed without JSX transformation.',
    signatures: ['React.createElement(type, props, ...children): ReactElement', 'React.useState(initial)', 'React.useEffect(effect, deps)'],
  },
  {
    name: 'host',
    description: 'Package-private JSON RPC from Client to this Package\'s Host half.',
    signatures: ['host.call(method: string, args?: JsonValue): Promise<JsonValue>'],
  },
  {
    name: 'styles',
    description: 'Package-owned stylesheet insertion cleaned up with the Client run.',
    signatures: ['styles.insert(css: string): () => void'],
  },
  {
    name: 'console',
    description: 'Package-tagged browser logging.',
    signatures: ['console.log(...values): void', 'console.error(...values): void'],
  },
]

/**
 * Construct the first-party Client provider registrations.
 * @param ctx - Client context used for live Service-backed queries.
 * @returns registrations for static catalogs and live Client capabilities.
 */
export function clientInspectProviders(ctx: Context): ClientCordisInspectProviderRegistration[] {
  return [
    registration(
      'Service',
      'Progressive Client Service discovery: compact capability/signature directory, then one exact coding contract.',
      'listService',
      input => queryServiceApi(readExact(input, 'service')) as unknown as JsonValue,
      SERVICE_INPUT,
      SERVICE_OUTPUT,
    ),
    registration(
      'Event',
      'Progressive Client Event discovery: compact listener directory, then one exact event contract.',
      'listEvents',
      input => queryEventApi(readExact(input, 'event')) as unknown as JsonValue,
      EVENT_INPUT,
      EVENT_OUTPUT,
    ),
    registration('Builtin', 'Plain-JavaScript symbols available to a dynamic Client half.', 'listBuiltins', () => ({
      builtins: [...CLIENT_BUILTIN_INSPECTION],
      referencedTypes: [],
    })),
    {
      manifest: {
        id: 'Slots',
        description: 'Progressive live Slot inspection with explicit Slot and Factory topology nodes.',
        methods: [{
          name: 'listSubTree',
          description: 'Return compact live Slot and Factory trees, plus available detail for one exact root.',
          inputSchema: SUBTREE_INPUT,
          outputSchema: SUBTREE_OUTPUT,
        }],
      },
      query(method, input) {
        if (method !== 'listSubTree') throw new Error(`unknown Slots inspect method "${method}"`)
        const slots = ctx.get('slots')
        if (slots === undefined) throw new Error('Client Slots service is not running')
        const root = typeof input === 'object' && input !== null && !Array.isArray(input)
          && typeof input.root === 'string' ? input.root : undefined
        const trees = slots.snapshot(root)
        const selected = trees[0]
        return Promise.resolve({
          ...root === undefined ? {} : { requestedRoot: { name: root, available: trees.length > 0 } },
          trees: trees.map(compactSlotTree),
          ...root === undefined || selected === undefined ? {} : { selected: inspectLiveSlot(selected) },
          referencedTypes: [],
        })
      },
    },
    registration('Theme', 'Current theme token names and light/dark override requirements.', 'listTokens', () => {
      const theme = ctx.get('theme')
      if (theme === undefined) throw new Error('Client Theme service is not running')
      return { tokens: theme.exportInspectTokens(), referencedTypes: [] } as unknown as JsonValue
    }),
  ]
}

/* jscpd:ignore-start */
function registration(
  id: string,
  description: string,
  method: string,
  query: (input: JsonValue | undefined) => JsonValue | Promise<JsonValue>,
  inputSchema: JsonValue = EMPTY_INPUT,
  outputSchema: JsonValue = ANY_OUTPUT,
): ClientCordisInspectProviderRegistration {
  return {
    manifest: {
      id,
      description,
      methods: [{
        name: method,
        description,
        inputSchema,
        outputSchema,
      }],
    },
    async query(requested, input) {
      if (requested !== method) throw new Error(`unknown ${id} inspect method "${requested}"`)
      return await query(input)
    },
  }
}

function exactInput(field: string, description: string): JsonValue {
  return { type: 'object', properties: { [field]: { type: 'string', description } }, additionalProperties: false }
}

function readExact(input: JsonValue | undefined, field: string): string | undefined {
  if (input === undefined || input === null || Array.isArray(input) || typeof input !== 'object') return undefined
  const value = input[field]
  return typeof value === 'string' ? value : undefined
}
/* jscpd:ignore-end */

type LiveCompositionNode = ReturnType<SlotRegistry['snapshot']>[number]

const SLOT_CATALOG = new Map(CLIENT_SLOT_API.map(entry => [entry.key, entry]))
const GUARDED_SLOT_KEYS = new Map<string, {
  description: string
  values: readonly { value: string; description: string }[]
}>([
  ['tool.view.cordis', {
    description: 'fixed by the dynamic Client Guard',
    values: [{
      value: 'self',
      description: 'The only accepted key. The Guard binds it to this Package\'s pluginId and packageId.',
    }],
  }],
])

function compactSlotTree(node: LiveCompositionNode): JsonValue {
  if (node.type === 'factory') {
    return {
      type: node.type,
      name: node.name,
      scope: node.scope,
      children: node.children.map(compactSlotTree),
    }
  }
  const catalog = SLOT_CATALOG.get(node.name)
  const guardedKeys = catalog === undefined ? undefined : GUARDED_SLOT_KEYS.get(catalog.key)
  return {
    type: node.type,
    name: node.name,
    kind: node.kind,
    scope: node.scope,
    ...catalog === undefined ? {} : {
      purpose: catalog.summary,
      replaceRisk: catalog.replaceRisk,
      ...catalog.registerOptions.length === 0 ? {} : {
        registration: catalog.registerOptions.map(option => ({
          name: option.name,
          type: option.type,
          required: option.requirement === 'required',
        })),
      },
      ...catalog.keyDomain === '' ? {} : {
        keyDomain: guardedKeys?.description ?? catalog.keyDomain,
        ...guardedKeys === undefined ? {} : { allowedKeys: guardedKeys.values.map(value => ({ ...value })) },
      },
    },
    children: node.children.map(compactSlotTree),
  }
}

function inspectLiveSlot(node: LiveCompositionNode): JsonValue {
  if (node.type === 'factory') {
    return {
      type: node.type,
      name: node.name,
      scope: node.scope,
      ...node.registrant === undefined ? {} : { registrant: node.registrant },
    }
  }
  const catalog = SLOT_CATALOG.get(node.name)
  return {
    type: node.type,
    name: node.name,
    kind: node.kind,
    scope: node.scope,
    ...node.declaredBy === undefined ? {} : { declaredBy: node.declaredBy },
    occupants: node.occupants.map(occupant => ({ ...occupant })),
    ...catalog === undefined ? {} : { catalog: inspectSlotCatalog(catalog) },
  }
}

function inspectSlotCatalog(entry: ClientSlotEntry): JsonValue {
  const guardedKeys = GUARDED_SLOT_KEYS.get(entry.key)
  return {
    description: entry.doc,
    registration: entry.registerOptions.map(option => ({
      name: option.name,
      type: option.type,
      required: option.requirement === 'required',
      description: option.doc,
    })),
    ownerProps: [...entry.ownerProps],
    ownerPropsReferences: [...entry.ownerPropsReferences],
    standardProps: [...entry.standardProps],
    keyDomain: guardedKeys?.description ?? entry.keyDomain,
    ...guardedKeys === undefined ? {} : { allowedKeys: guardedKeys.values.map(value => ({ ...value })) },
    hookContext: entry.hookContext,
    slotInject: entry.slotInject,
    replaceRisk: entry.replaceRisk,
  }
}
