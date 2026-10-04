/**
 * PTC mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
 * text the model programs against (the `tools:sdk` prompt section). Sibling of
 * `json-schema.ts` — `schemas()` (native function calling) and this module (the generated
 * `declare const tools` API) are two projections of the same store.
 * @module @deepseek-ai/dsh-tools/src/ts-types
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema } from './json-schema.ts'
import type { JsonSchemaNode, JsonSchemaScalar } from './json-schema.ts'
/** Internal PTC mode projection: the model-facing schema plus the canonical output schema. */
export interface ToolSdkSchema extends ToolSchema {
  /** Validated canonical value returned by the tool binding. */
  output: JsonSchemaNode
}

/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** One `indent`-deep line prefix (two spaces per level). */
function pad(indent: number): string {
  return '  '.repeat(indent)
}

/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines(description: unknown, indent: number): string[] {
  if (typeof description !== 'string' || description.length === 0) return []
  // Collapse prose to stable one-line docs and escape comment closers so a
  // schema description cannot terminate generated JSDoc.
  const collapsed = description.replace(/\s+/g, ' ').trim()
  return [`${pad(indent)}/** ${collapsed.replaceAll('*/', String.raw`*\/`)} */`]
}

/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value: JsonSchemaScalar): string {
  return JSON.stringify(value)
}

/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar(node: Record<string, unknown>, type: string): string {
  const broad = type === 'integer' ? 'number' : type
  if (Object.hasOwn(node, 'const')) return renderScalar(node.const as JsonSchemaScalar)
  if (Object.hasOwn(node, 'enum')) {
    return (node.enum as JsonSchemaScalar[]).map(renderScalar).join(' | ')
  }
  return broad
}

/** A composable type document that can be flattened without recursive string concatenation. */
interface TypeDocument {
  readonly parts: readonly (string | TypeDocument)[]
  readonly containsUnionOrIntersection: boolean
}

/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
function typeDocumentFrom(parts: readonly (string | TypeDocument)[]): TypeDocument {
  return {
    parts,
    containsUnionOrIntersection: parts.some(part => typeof part === 'string'
      ? part.includes('|') || part.includes('&')
      : part.containsUnionOrIntersection),
  }
}

/** Build a small document without an intermediate array at each call site. */
function typeDocument(...parts: (string | TypeDocument)[]): TypeDocument {
  return typeDocumentFrom(parts)
}

/** Flatten a nested document with an explicit work stack. */
function flattenTypeDocument(document: TypeDocument): string {
  const chunks: string[] = []
  const tasks: (string | TypeDocument)[] = [document]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (typeof task === 'string') {
      chunks.push(task)
      continue
    }
    for (let index = task.parts.length - 1; index >= 0; index--) {
      const part = task.parts[index]
      /* v8 ignore next -- the loop is bounded by the captured part count. */
      if (part !== undefined) tasks.push(part)
    }
  }
  return chunks.join('')
}

/** One explicit call frame for stack-safe schema-to-TypeScript rendering. */
interface SchemaRenderFrame {
  readonly node: JsonSchemaNode
  readonly indent: number
  phase: 'start' | 'children'
  kind?: 'oneOf' | 'array' | 'object'
  children: { node: JsonSchemaNode; indent: number }[]
  childIndex: number
  childDocuments: TypeDocument[]
  entries: [string, JsonSchemaNode][]
}

/** Initialize one schema-render frame with empty aggregation state. */
function schemaRenderFrame(node: JsonSchemaNode, indent: number): SchemaRenderFrame {
  return { node, indent, phase: 'start', children: [], childIndex: 0, childDocuments: [], entries: [] }
}

/** Render an already asserted schema to a composable document. */
function renderSupportedSchema(schema: JsonSchemaNode, indent: number): TypeDocument {
  const frames: SchemaRenderFrame[] = [schemaRenderFrame(schema, indent)]
  let rootDocument: TypeDocument | undefined
  const finish = (document: TypeDocument): void => {
    frames.pop()
    const parent = frames.at(-1)
    if (parent === undefined) rootDocument = document
    else parent.childDocuments.push(document)
  }

  while (frames.length > 0) {
    const frame = frames.at(-1)
    /* v8 ignore next -- the loop condition guarantees a current frame. */
    if (frame === undefined) break
    if (frame.phase === 'children') {
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex]
        /* v8 ignore next -- childIndex is bounded by children.length. */
        if (child === undefined) throw new Error('missing schema render child')
        frame.childIndex++
        frames.push(schemaRenderFrame(child.node, child.indent))
        continue
      }
      if (frame.kind === 'oneOf') {
        const parts: (string | TypeDocument)[] = []
        for (let index = 0; index < frame.childDocuments.length; index++) {
          if (index > 0) parts.push(' | ')
          const child = frame.childDocuments[index]
          /* v8 ignore next -- child documents correspond one-to-one with children. */
          if (child !== undefined) parts.push(child)
        }
        finish(typeDocumentFrom(parts))
        continue
      }
      if (frame.kind === 'array') {
        const child = frame.childDocuments[0]
        /* v8 ignore next -- array frames always schedule exactly one child. */
        if (child === undefined) throw new Error('missing array item type')
        finish(child.containsUnionOrIntersection
          ? typeDocument('(', child, ')[]')
          : typeDocument(child, '[]'))
        continue
      }

      const required = new Set(frame.node.required)
      const parts: (string | TypeDocument)[] = ['{']
      for (let index = 0; index < frame.entries.length; index++) {
        const entry = frame.entries[index]
        const child = frame.childDocuments[index]
        /* v8 ignore next -- object entries and child documents have the same length. */
        if (entry === undefined || child === undefined) throw new Error('missing object property type')
        const [name, prop] = entry
        for (const line of docLines(prop.description, frame.indent + 1)) parts.push('\n', line)
        parts.push('\n', `${pad(frame.indent + 1)}${renderKey(name)}${required.has(name) ? '' : '?'}: `, child, ';')
      }
      parts.push('\n', `${pad(frame.indent)}}`)
      const declared = typeDocumentFrom(parts)
      finish(frame.node.additionalProperties === false
        ? declared
        : typeDocument(declared, ' & Record<string, JsonValue>'))
      continue
    }

    const node = frame.node
    if (node.oneOf !== undefined) {
      frame.kind = 'oneOf'
      frame.children = Array.from(node.oneOf, child => ({ node: child, indent: frame.indent }))
      frame.childIndex = 0
      frame.childDocuments = []
      frame.phase = 'children'
      continue
    }
    if (node.type === undefined) {
      finish(typeDocument('JsonValue'))
      continue
    }
    switch (node.type) {
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        finish(typeDocument(renderConstrainedScalar(node as Record<string, unknown>, node.type)))
        break
      case 'array':
        if (node.items === undefined) {
          finish(typeDocument('JsonValue[]'))
        } else {
          frame.kind = 'array'
          frame.children = [{ node: node.items, indent: frame.indent }]
          frame.childIndex = 0
          frame.childDocuments = []
          frame.phase = 'children'
        }
        break
      case 'object': {
        const open = node.additionalProperties !== false
        const entries = Object.entries(node.properties ?? {})
        if (entries.length === 0) {
          finish(typeDocument(open ? 'Record<string, JsonValue>' : 'Record<string, never>'))
        } else {
          frame.kind = 'object'
          frame.entries = entries
          frame.children = entries.map(([, child]) => ({ node: child, indent: frame.indent + 1 }))
          frame.childIndex = 0
          frame.childDocuments = []
          frame.phase = 'children'
        }
        break
      }
      /* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
      default:
        finish(typeDocument('unknown'))
    }
  }

  /* v8 ignore next -- every root frame produces one document. */
  return rootDocument ?? typeDocument('unknown')
}

/**
 * Map one enforced JSON-Schema node to a TypeScript type literal. Supports
 * every unified schema construct and returns `unknown` for malformed or
 * unsupported inputs without throwing.
 * @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
 * @param indent - the indentation level for nested object members.
 * @returns the TS type text (multi-line for objects with properties).
 */
export function jsonSchemaToTs(schema: unknown, indent = 0): string {
  try {
    assertSupportedJsonSchema(schema)
    return flattenTypeDocument(renderSupportedSchema(schema, indent))
  } catch {
    return 'unknown'
  }
}

/** The fixed model-facing usage contract rendered above the declarations (see the PTC mode Agent Note's "What the model sees"). */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` takes two required arguments: \`description\`, a short summary of what the program does, and \`code\` — the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped). The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly.`

const SDK_PROGRAM_INSTRUCTIONS = `Inside the program:

- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:`

/** Whether one string schema accepts the literal used by the bash example. */
function acceptsExampleString(schema: JsonSchemaNode | undefined, value: string): boolean {
  return schema?.type === 'string'
    && (schema.const === undefined || schema.const === value)
    && (schema.enum === undefined || schema.enum.includes(value))
}

/** Render the bash example only when its literal arguments satisfy the current parameter schema. */
function renderBashExample(schemas: ToolSdkSchema[]): string {
  const bash = schemas.find(schema => schema.name === 'bash')
  if (bash === undefined) return ''
  const parameters = bash.parameters as JsonSchemaNode
  if (parameters.type !== 'object') return ''
  const required = parameters.required ?? []
  if (required.some(name => name !== 'command' && name !== 'description')) return ''
  if (!acceptsExampleString(parameters.properties?.command, 'pwd')) return ''
  const needsDescription = required.includes('description')
  if (needsDescription && !acceptsExampleString(parameters.properties?.description, 'Show current directory')) return ''
  const description = needsDescription ? "description: 'Show current directory', " : ''
  return ` When no separate \`bash\` schema is supplied, invoke a declared \`bash\` binding inside \`run_code\`:\n\n\`run_code({ description: "Show current directory", code: "return await tools.bash({ ${description}command: 'pwd' })" })\``
}

/**
 * Render the full `tools:sdk` prompt section: the fixed usage instructions
 * plus one `declare const tools` interface covering every given tool.
 * Deterministic — tools are emitted in lexicographic name order, so an
 * unchanged tool set produces byte-identical text across assemblies. The sort
 * is not a total order on byte-equal names, so two schemas sharing a name
 * would render in argument order; the caller's visible-capability map is keyed
 * by name, so the input never carries a duplicate.
 * @param schemas - the tool schemas to declare (the caller excludes
 *   `run_code` itself).
 * @returns the complete section text.
 */
export function renderToolsSdk(schemas: ToolSdkSchema[]): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const argsMembers: string[] = []
  const outputMembers: string[] = []
  for (const schema of sorted) {
    argsMembers.push(...docLines(schema.description, 1))
    argsMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`)
    outputMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`)
  }
  const argsMap = `interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join('\n')}\n` : ''}}`
  const outputMap = `interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join('\n')}\n` : ''}}`
  const declaration = [
    argsMap,
    outputMap,
    'type ToolName = keyof ToolOutputMap',
    ['declare class ToolCallError extends Error {', '  readonly name: "ToolCallError";', '  readonly toolName: ToolName;', '}'].join('\n'),
    ['declare const tools: {', '  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;', '}'].join('\n'),
  ].join('\n\n')
  const jsonValue = 'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }'
  return `${SDK_INSTRUCTIONS}${renderBashExample(sorted)}\n\n${SDK_PROGRAM_INSTRUCTIONS}\n\n\`\`\`ts\n${jsonValue}\n\n${declaration}\n\`\`\``
}
