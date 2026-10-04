import { describe, expect, it } from 'vitest'
import { jsonSchemaToPy, renderToolsSdkPy } from '@deepseek-ai/dsh-tools/src/py-types.ts'
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolSdkSchema } from '@deepseek-ai/dsh-tools/src/ts-types.ts'

describe('jsonSchemaToPy', () => {
  it('maps the defineTool DSL subset', () => {
    const cases: [unknown, string][] = [
      [{ type: 'string' }, 'str'],
      [{ type: 'number' }, 'float'],
      [{ type: 'boolean' }, 'bool'],
      [{ type: 'string', enum: ['a', 'b'] }, 'Literal["a", "b"]'],
      [{ type: 'array', items: { type: 'number' } }, 'list[float]'],
      [{ type: 'array', items: { type: 'string', enum: ['x', 'y'] } }, 'list[Literal["x", "y"]]'],
      [{ type: 'array' }, 'list[Any]'],
      [{ type: 'object' }, 'dict[str, Any]'],
      [{ type: 'object', properties: {} }, 'dict[str, Any]'],
      [{ type: 'object', properties: { x: { type: 'string' } } }, 'dict[str, Any]'],
    ]
    for (const [schema, expected] of cases) {
      expect(jsonSchemaToPy(schema), JSON.stringify(schema)).toBe(expected)
    }
  })

  it('is total: unsupported or hostile constructs degrade to Any, never throw', () => {
    const cases: unknown[] = [
      undefined,
      null,
      42,
      'string-schema',
      {},
      { oneOf: 7 },
      { $ref: '#/defs/x' },
      { type: 'object', properties: 7 },
      { type: 'string', enum: [1, 2] },
      { type: 'string', enum: [] },
    ]
    for (const schema of cases) {
      expect(() => jsonSchemaToPy(schema), JSON.stringify(schema)).not.toThrow()
    }
    expect(jsonSchemaToPy({ type: 'integer' })).toBe('int')
    expect(jsonSchemaToPy({ type: 'string', const: 'fixed' })).toBe('Literal["fixed"]')
    expect(jsonSchemaToPy({ type: 'boolean', const: true })).toBe('Literal[True]')
    expect(jsonSchemaToPy({ type: 'number', const: 1.5 })).toBe('Literal[1.5]')
    expect(jsonSchemaToPy({ type: 'boolean', enum: [false] })).toBe('Literal[False]')
    expect(jsonSchemaToPy({ type: 'null' })).toBe('None')
    expect(jsonSchemaToPy({ oneOf: [{ type: 'string' }, { type: 'null' }] })).toBe('str | None')
    expect(jsonSchemaToPy({ oneOf: [] })).toBe('Any')
    expect(jsonSchemaToPy({ type: 'object', properties: 7 })).toBe('Any')
    expect(jsonSchemaToPy({ type: 'string', enum: [1, 2] })).toBe('Any')
    expect(jsonSchemaToPy({ type: 'string', enum: [] })).toBe('Any')
  })

  it('leans on JSON.stringify to keep a Literal parseable', () => {
    // Nothing here escapes anything itself; `JSON.stringify` carries both
    // classes of hazard. The two kinds of code point CPython refuses anywhere
    // in source: NUL, and the D800–DFFF unpaired-surrogate block under ES2019
    // well-formed stringification.
    expect(jsonSchemaToPy({ type: 'string', const: 'a\u0000b' })).toBe(String.raw`Literal["a\u0000b"]`)
    expect(jsonSchemaToPy({ type: 'string', enum: ['a\ud800b'] })).toBe(String.raw`Literal["a\ud800b"]`)
    // And the ones that break this line in particular: a bare quote closing
    // the literal early, a trailing ODD backslash eating the closing quote (an
    // even run does not), a bare newline ending it before its terminator.
    // Every escape it emits is also a Python escape for the same character, so
    // the value round-trips.
    expect(jsonSchemaToPy({ type: 'string', const: 'say "hi"\n' })).toBe(String.raw`Literal["say \"hi\"\n"]`)
    expect(jsonSchemaToPy({ type: 'string', const: 'ends\\' })).toBe(String.raw`Literal["ends\\"]`)
  })

  it('passes NEL and the line/paragraph separators through raw, which CPython does not treat as line terminators', () => {
    // `JSON.stringify` escapes LF and CR but not NEL (U+0085), LS (U+2028), or
    // PS (U+2029), which is safe here and not by accident: those three are
    // `str.splitlines()` boundaries, not tokenizer line terminators, so they
    // end neither a string literal nor a `#` comment — measured on CPython
    // 3.9.6 and 3.12.13. Pinning the raw form keeps a later "escape them for
    // symmetry with LF" change from landing as a silent both-flavors
    // divergence from `ts-types`. Escapes below — the two forms denote the
    // same bytes, and none of the three has a visible width.
    expect(jsonSchemaToPy({ type: 'string', const: 'a\u2028b' })).toBe('Literal["a\u2028b"]')
    expect(jsonSchemaToPy({ type: 'string', enum: ['a\u2029b'] })).toBe('Literal["a\u2029b"]')
    // NEL is inside `UNPRINTABLE`'s class, so the description path escapes it.
    // This is one of the two routes that carry it raw; the other is the
    // subscript tool-name comment's own `JSON.stringify` call.
    expect(jsonSchemaToPy({ type: 'string', const: 'a\u0085b' })).toBe('Literal["a\u0085b"]')
  })

  it('emits exact digits for a beyond-safe-range integer literal', () => {
    // Python integers are arbitrary-precision, so the emitted digits ARE the
    // value the model programs against. `String(2 ** 60)` prints the rounded
    // ...847000, which is a DIFFERENT integer from the double's exact
    // ...846976: `Number::toString` is shortest round-trip, so it emits the 16
    // digits that re-read to the same double and pads with zeros, and those
    // padded digits name an integer no double holds. Passing one back would
    // have to cross the argument boundary as a JSON number, so the SDK would
    // document a value no program can pass. This assertion is what separates
    // the two spellings; the 1e21 case below separates them again on the other
    // failure mode, where `String` gives no integer literal at all.
    expect(jsonSchemaToPy({ type: 'integer', const: 2 ** 60 })).toBe('Literal[1152921504606846976]')
    expect(jsonSchemaToPy({ type: 'integer', enum: [2 ** 60, -(2 ** 60)] }))
      .toBe('Literal[1152921504606846976, -1152921504606846976]')
    // `String(1e21)` prints `1e+21`, not a Python integer literal at all. The
    // rule keys off the VALUE, not the declared type, so a `number` const that
    // happens to be an integral double is spelled the same exact way (both
    // spellings denote the same double, and only the digits also denote the
    // same Python integer).
    expect(jsonSchemaToPy({ type: 'integer', const: 1e21 })).toBe('Literal[1000000000000000000000]')
    expect(jsonSchemaToPy({ type: 'number', const: 1e21 })).toBe('Literal[1000000000000000000000]')
    // Within the safe range, and for non-integral numbers, the plain spelling
    // is already exact and stays unchanged.
    expect(jsonSchemaToPy({ type: 'integer', const: 2 ** 53 - 1 })).toBe('Literal[9007199254740991]')
    expect(jsonSchemaToPy({ type: 'number', const: 1e-7 })).toBe('Literal[1e-7]')
  })
})

describe('renderToolsSdkPy', () => {
  const bash: ToolSdkSchema = {
    name: 'bash',
    description: 'Run a shell command.',
    parameters: parameterSchemaSpecToJsonSchema({ command: { type: 'string', required: true } }) as unknown as Record<string, unknown>,
    output: { type: 'string' },
  }
  const exotic: ToolSdkSchema = {
    name: 'my-mcp.tool',
    description: 'Exotic name.',
    parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
    output: { type: 'string' },
  }
  const reserved: ToolSdkSchema = {
    name: 'class',
    description: 'Uses a reserved Python word.',
    parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
    output: { type: 'string' },
  }
  /** One tool carrying `description` at both emission sites: the method docstring and the field comment. */
  const described = (description: string): ToolSdkSchema => ({
    name: 'weird',
    description,
    parameters: parameterSchemaSpecToJsonSchema({
      field: { type: 'string', required: true, description },
    }) as unknown as Record<string, unknown>,
    output: { type: 'string' },
  })

  it('declares identifier tools as async methods and lists exotic/reserved names as subscript comments', () => {
    const text = renderToolsSdkPy([exotic, bash, reserved])
    expect(text).toContain('class Tools(Protocol):')
    // The argument object is a named TypedDict, not an opaque dict.
    expect(text).toContain('class BashArgs(TypedDict):')
    expect(text).toContain('async def bash(self, args: BashArgs) -> str:')
    // Empty-property tools keep the opaque dict (nothing to name).
    expect(text).toContain('# tools["my-mcp.tool"](args: dict[str, Any]) -> str')
    expect(text).toContain('# tools["class"](args: dict[str, Any]) -> str')
    // Fixed instruction lines the model relies on.
    expect(text).toContain('top-level `await`')
    // The binding boundary: `tools`/`ToolCallError` are bound, the TypedDicts
    // are not. Both halves are pinned — dropping either one turns a correct
    // contract into a wrong one (a model that reads only "STATIC STUB" would
    // stop catching `ToolCallError`).
    expect(text).toContain('exactly two of the names declared below are bound: `tools` and `ToolCallError`')
    expect(text).toContain('never `FooArgs(field=1)`, which raises `NameError`')
    expect(text).toContain('ToolCallError')
    expect(text).toContain('class ToolCallError(Exception):')
    expect(text).toContain('MAY overlap under `asyncio.gather`')
    expect(text).toContain('lossless JSON')
    expect(text).toContain('```python')
    expect(text).toContain('tools: Tools')
  })

  it('lists the required description before the program', () => {
    const text = renderToolsSdkPy([bash])
    expect(text).toContain('`code`')
    expect(text).toContain('`description`')
    expect(text).toContain('two required arguments: `description`, a short summary of what the program does, and `code`')
  })

  it('renders required as plain fields and optional as NotRequired, with per-field description comments', () => {
    const tool: ToolSdkSchema = {
      name: 'search',
      description: 'Search for text.',
      parameters: parameterSchemaSpecToJsonSchema({
        query: { type: 'string', required: true, description: 'What to search for.' },
        limit: { type: 'number', description: 'Max results.' },
      }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('class SearchArgs(TypedDict):')
    expect(text).toContain('    # What to search for.')
    expect(text).toContain('    query: str')
    expect(text).toContain('    # Max results.')
    expect(text).toContain('    limit: NotRequired[float]')
    expect(text).toContain('async def search(self, args: SearchArgs) -> str:')
    // NotRequired is imported because an optional field used it; Any is NOT,
    // since every type here is concrete — the import line lists only what ran.
    expect(text).toContain('from typing import NotRequired, Protocol, TypedDict')
  })

  it('prefixes Tool when a name CamelCases to a non-letter head, and degrades a malformed schema to Any', () => {
    const tool: ToolSdkSchema = {
      name: '1st-tool', // subscript path; CamelCases to "1stTool" → prefixed "Tool1stTool"
      description: 'Hostile-shape probe.',
      // Malformed node: the unified schema validator rejects it whole, so the
      // args position degrades to Any (registration would refuse this schema;
      // the renderer just must not throw on it).
      parameters: { type: 'object', properties: { field: { type: 'string', description: 42 } } },
      output: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('# tools["1st-tool"](args: Any) -> Tool1stToolOutput')
    expect(text).toContain('class Tool1stToolOutput(TypedDict):')
    expect(text).toContain('    ok: bool')
  })

  it('treats every field as optional when the object carries no required array', () => {
    const tool: ToolSdkSchema = {
      name: 'all_optional',
      description: 'No required array.',
      parameters: { type: 'object', properties: { flag: { type: 'boolean' } } },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('    flag: NotRequired[bool]')
  })

  it('renders an enum inside an object property as a Literal field', () => {
    const tool: ToolSdkSchema = {
      name: 'mode_tool',
      description: 'Pick a mode.',
      parameters: parameterSchemaSpecToJsonSchema({
        mode: { type: 'string', required: true, enum: ['fast', 'slow'] },
      }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('class ModeToolArgs(TypedDict):')
    expect(text).toContain('    mode: Literal["fast", "slow"]')
    expect(text).toContain('from typing import Literal, Protocol, TypedDict')
  })

  it('renders one level of nested object as its own named TypedDict declared before the parent', () => {
    const tool: ToolSdkSchema = {
      name: 'workflow',
      description: 'Run a workflow.',
      parameters: parameterSchemaSpecToJsonSchema({
        meta: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: 'Identity block.',
          properties: {
            name: { type: 'string', required: true, description: 'Short name.' },
            phases: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { title: { type: 'string', required: true, description: 'Phase title.' } },
              },
            },
          },
        },
      }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    // Nested class for the `meta` object, and a further nested class for the
    // array item object, each named after its field path.
    expect(text).toContain('class WorkflowArgsMeta(TypedDict):')
    expect(text).toContain('class WorkflowArgsMetaPhases(TypedDict):')
    expect(text).toContain('    meta: WorkflowArgsMeta')
    expect(text).toContain('    phases: NotRequired[list[WorkflowArgsMetaPhases]]')
    // Dependency-before-dependent: the item class precedes its container,
    // which precedes the top-level args class, which precedes the protocol.
    expect(text.indexOf('class WorkflowArgsMetaPhases')).toBeLessThan(text.indexOf('class WorkflowArgsMeta(TypedDict):'))
    expect(text.indexOf('class WorkflowArgsMeta(TypedDict):')).toBeLessThan(text.indexOf('class WorkflowArgs(TypedDict):'))
    expect(text.indexOf('class WorkflowArgs(TypedDict):')).toBeLessThan(text.indexOf('class Tools(Protocol):'))
  })

  it('renders a oneOf of object branches as a union of named TypedDicts declared before the parent', () => {
    const tool: ToolSdkSchema = {
      name: 'act',
      description: 'Union output.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          { type: 'object', additionalProperties: false, properties: { err: { type: 'string' } }, required: ['err'] },
        ],
      },
    }
    const text = renderToolsSdkPy([tool])
    // Each object branch becomes its own named class (`${base}Output1/2`),
    // declared before the protocol references the union.
    expect(text).toContain('class ActOutput1(TypedDict):')
    expect(text).toContain('class ActOutput2(TypedDict):')
    expect(text).toContain('-> ActOutput1 | ActOutput2')
    expect(text.indexOf('class ActOutput1(TypedDict):')).toBeLessThan(text.indexOf('class Tools(Protocol):'))
    expect(text.indexOf('class ActOutput2(TypedDict):')).toBeLessThan(text.indexOf('class Tools(Protocol):'))
  })

  it('degrades a context-free oneOf of object branches to a union of dict[str, Any]', () => {
    // jsonSchemaToPy has no naming context, so each object branch degrades
    // rather than declaring a class.
    const type = jsonSchemaToPy({
      oneOf: [
        { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        { type: 'string' },
      ],
    })
    expect(type).toBe('dict[str, Any] | str')
    // Both branches objects, and the same shape reached through an array: the
    // marker is the CALL's className, so a propagated frame name (`1`, the
    // index-derived branch name) does not revive class declaration on a walk
    // that has nowhere to declare into.
    const object = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    expect(jsonSchemaToPy({ oneOf: [object, object] })).toBe('dict[str, Any] | dict[str, Any]')
    expect(jsonSchemaToPy({ type: 'array', items: { oneOf: [object, { type: 'string' }] } })).toBe('list[dict[str, Any] | str]')
  })

  it('suffixes a counter when two tools CamelCase to the same class base', () => {
    const a: ToolSdkSchema = {
      name: 'my-tool',
      description: 'Dash form.',
      parameters: parameterSchemaSpecToJsonSchema({ x: { type: 'string', required: true } }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const b: ToolSdkSchema = {
      name: 'my.tool',
      description: 'Dot form.',
      parameters: parameterSchemaSpecToJsonSchema({ y: { type: 'string', required: true } }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([a, b])
    // Both sanitize to `MyToolArgs`; the second collides and gets a suffix.
    expect(text).toContain('class MyToolArgs(TypedDict):')
    expect(text).toContain('class MyToolArgs2(TypedDict):')
  })

  it('caps class-name length so a deep single-field chain stays linear', () => {
    // Child class names derive from their parent's, so without a cap the sum of
    // names would be Theta(depth^2). MAX_CLASS_NAME_BASE (120) bounds each name.
    const depth = 4000
    let schema: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < depth; i++) {
      schema = { type: 'object', additionalProperties: false, properties: { inner: schema }, required: ['inner'] }
    }
    const tool: ToolSdkSchema = { name: 'deep', description: 'Deep chain.', parameters: schema, output: { type: 'string' } }
    const text = renderToolsSdkPy([tool])
    const longestClassName = [...text.matchAll(/^class (\w+)\(TypedDict\):/gm)].reduce((max, m) => Math.max(max, m[1]?.length ?? 0), 0)
    expect(longestClassName).toBeLessThanOrEqual(140)
    expect(text.length).toBeLessThan(depth * 400)
  })

  it('skips an already-taken counter suffix when a sibling object occupies it', () => {
    // `phase` and `Phase` both CamelCase to base `FooArgsPhase`; `phase2`
    // independently takes `FooArgsPhase2`, so `Phase`'s collision scan must
    // advance to `FooArgsPhase3` (exercises the collision-skip loop).
    const obj = (field: string) => ({ type: 'object' as const, additionalProperties: false, properties: { [field]: { type: 'string' } } })
    const tool: ToolSdkSchema = {
      name: 'foo',
      description: 'Sibling objects with colliding class bases.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { phase: obj('a'), phase2: obj('b'), Phase: obj('c') },
        required: ['phase', 'phase2', 'Phase'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('class FooArgsPhase(TypedDict):')
    expect(text).toContain('class FooArgsPhase2(TypedDict):')
    expect(text).toContain('class FooArgsPhase3(TypedDict):')
  })

  it('references the named TypedDict from a reserved/subscript tool too', () => {
    const tool: ToolSdkSchema = {
      name: 'class',
      description: 'Reserved word tool.',
      parameters: parameterSchemaSpecToJsonSchema({ value: { type: 'string', required: true } }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('class ClassArgs(TypedDict):')
    expect(text).toContain('# tools["class"](args: ClassArgs) -> str')
  })

  it('degrades an object to dict[str, Any] when a field name is not a legal Python attribute', () => {
    const tool: ToolSdkSchema = {
      name: 'weird_fields',
      description: 'Has an illegal field name.',
      parameters: { type: 'object', properties: { 'a-b': { type: 'string' } } },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('async def weird_fields(self, args: dict[str, Any]) -> str:')
    expect(text).not.toContain('WeirdFieldsArgs')
  })

  it('keeps soft-keyword field names as TypedDict fields (each is special in exactly one syntactic position)', () => {
    const tool: ToolSdkSchema = {
      name: 'search',
      description: 'Soft keywords as fields.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          match: { type: 'string' },
          case: { type: 'boolean' },
          type: { type: 'string' },
        },
        required: ['match'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    // The object keeps its shape rather than degrading to dict[str, Any].
    expect(text).toContain('class SearchArgs(TypedDict):')
    expect(text).toContain('match: str')
    expect(text).toContain('case: NotRequired[bool]')
    expect(text).toContain('type: NotRequired[str]')
    expect(text).not.toContain('dict[str, Any]')
  })

  it('keeps a non-ASCII field name as a TypedDict field and derives its class name from it', () => {
    // `路径` satisfies `xid_start xid_continue*`, so CPython accepts it as an
    // attribute and as the `TypedDict` key. Rejecting it would degrade the
    // whole object, dropping every SIBLING field's name, requiredness and type
    // too — and under `mode: 'ptc'` the native schemas are omitted, so
    // nothing else carries them. The nested class name is from the field, so
    // `camelCase` has to pass the same characters through instead of splitting
    // on them.
    const tool: ToolSdkSchema = {
      name: '搜索',
      description: 'Unicode identifiers.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          路径: { type: 'string' },
          opts: { type: 'object', additionalProperties: false, properties: { 深度: { type: 'number' } } },
        },
        required: ['路径'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('async def 搜索(self, args: 搜索Args) -> str:')
    expect(text).toContain('class 搜索Args(TypedDict):')
    expect(text).toContain('    路径: str')
    expect(text).toContain('class 搜索ArgsOpts(TypedDict):')
    expect(text).toContain('    深度: NotRequired[float]')
    expect(text).not.toContain('dict[str, Any]')
  })

  it('degrades a field name that NFKC-normalizes to something else, which would be declared under another spelling', () => {
    // U+FB01 LATIN SMALL LIGATURE FI passes the identifier grammar, but CPython
    // normalizes identifiers at compile time while the harness compares the
    // JSON key as written: `ﬁeld: str` would declare and be reachable as
    // `field`, a key the tool never accepts. Two keys that normalize together
    // would additionally collapse into one declaration. The subscript path
    // carries the exact bytes instead.
    const text = renderToolsSdkPy([
      {
        name: 'ligature',
        description: 'Normalizing field name.',
        parameters: { type: 'object', additionalProperties: false, properties: { ﬁeld: { type: 'string' } } },
        output: { type: 'string' },
      },
    ])
    expect(text).toContain('async def ligature(self, args: dict[str, Any]) -> str:')
    expect(text).not.toContain('ﬁeld:')
    expect(text).not.toContain('field:')
  })

  it('keeps U+200C in a name tail while rejecting it at a name head, per the two XID properties', () => {
    // ZWNJ carries `XID_Continue` and not `XID_Start`, so the predicate splits
    // on position: bare in a tail, subscripted at a head. Both verdicts are
    // stable across the supported engines — the property arrives in Unicode
    // 15.1 and the floor (Node 22.19.0, Unicode 16.0) is past it.
    //
    // The interpreter side is where this one skews, and it is the same skew the
    // docstring's four other characters record, reached in a tail position
    // instead of at a head: CPython reads XID_Continue out of the
    // `DerivedCoreProperties.txt` of the UCD it was built against (13.0.0 on
    // 3.9.6 and 15.0.0 on 3.12.13 both lack the row, and
    // `'a\u200Cb'.isidentifier()` is False on both, measured). What then needs
    // 15.1 tables or newer is the bare field, once in each class, and the
    // `Tool\u200CbArgs` class name. The subscript comment quoting the tool name
    // is not one of them: it is not parsed as an identifier.
    const of = (name: string): ToolSdkSchema => ({
      name,
      description: `Tool ${name}.`,
      parameters: { type: 'object', additionalProperties: false, properties: { 'a\u200Cb': { type: 'string' } } },
      output: { type: 'string' },
    })
    const text = renderToolsSdkPy([of('ping'), of('\u200Cb')])
    expect(text).toContain('async def ping(self, args: PingArgs) -> str:')
    expect(text).toContain('    a\u200Cb: NotRequired[str]')
    // A head that is XID_Continue but not XID_Start takes the subscript path,
    // and `camelCase` prefixes `Tool` to make the class name start legally.
    expect(text).toContain('# tools["\u200Cb"](args: Tool\u200CbArgs) -> str')
    expect(text).toContain('class Tool\u200CbArgs(TypedDict):')
    expect(text).not.toContain('async def \u200Cb')
  })

  it('subscripts a tool name that NFKC-normalizes to something else, while declaring a plain Unicode one', () => {
    // Same split at the tool-name site: `路径` becomes an `async def`, the
    // ligature name cannot, because `async def ﬁnd` would define `find`. The
    // subscript comment quotes the name, so its exact bytes survive, and its
    // TypedDict is still named and referenced — the name is only unusable as a
    // method, not as a class-name source. The `FInd` spelling comes from `ﬁ`'s
    // multi-character full case mapping (`'ﬁ'.toUpperCase()` is `'FI'`), not
    // from `camelCase`'s NFKC step, which is the identity on `FInd`: the
    // ligature is XID_Start, so the split set keeps it and only the
    // capitalization of the head transforms it.
    const of = (name: string): ToolSdkSchema => ({
      name,
      description: `Tool ${name}.`,
      parameters: { type: 'object', additionalProperties: false, properties: { q: { type: 'string' } }, required: ['q'] },
      output: { type: 'string' },
    })
    const text = renderToolsSdkPy([of('路径'), of('ﬁnd')])
    expect(text).toContain('async def 路径(self, args: 路径Args) -> str:')
    expect(text).toContain('# tools["ﬁnd"](args: FIndArgs) -> str')
    expect(text).toContain('class FIndArgs(TypedDict):')
    expect(text).not.toContain('async def ﬁnd')
    expect(text).not.toContain('async def find')
  })

  it('derives a class name through the case-mapping table, independently of the bare-name predicate', () => {
    // The head capitalization reads a table `isBareIdentifier` never consults,
    // so the class-name path can carry a character the predicate cleared. ƛ
    // (U+019B) is XID_Start and NFKC-stable, so the method is emitted bare;
    // the head maps to Ƛ (U+A7DC), a code point the engine's tables assign and
    // an older interpreter's do not. This pins which table produced the name,
    // so a change to the mapping step shows up here rather than only in a
    // downstream Python parse.
    //
    // Unlike the other Unicode cases in this file, the table row is recent:
    // U+A7DC and the U+019B uppercase mapping to it both arrive in Unicode
    // 16.0 (`DerivedAge.txt`; CPython 3.12.13's 15.0.0 has neither). The
    // engines floor sits exactly there with no margin — Node 22.19.0 reports
    // Unicode 16.0 (ICU 77.1) and maps U+019B to U+A7DC, measured — so an
    // engine below the floor fails here as a renderer regression whose real
    // cause is the table version.
    const text = renderToolsSdkPy([
      {
        name: 'ƛ',
        description: 'Lambda with stroke.',
        parameters: { type: 'object', additionalProperties: false, properties: { q: { type: 'string' } }, required: ['q'] },
        output: { type: 'string' },
      },
    ])
    expect(text).toContain('async def ƛ(self, args: ꟜArgs) -> str:')
    expect(text).toContain('class ꟜArgs(TypedDict):')
    expect(text).not.toContain('class ƛArgs')
  })

  it('drops a surrogate half rather than cutting a pair when capping an astral class-name base', () => {
    // Class-name bases are capped by `slice`, which counts UTF-16 code units,
    // so a boundary landing inside an astral pair would leave a lone high
    // surrogate — not an identifier character, and not encodable text. Padding
    // with one ASCII character shifts the boundary onto the pair.
    // U+10330 GOTHIC LETTER AHSA: XID_Start and NFKC-stable, unlike `𝕏`, which
    // NFKC-folds to ASCII `X` and so never reaches the boundary at all.
    const AHSA = String.fromCodePoint(0x10330)
    const className = (pad: string): string => {
      const text = renderToolsSdkPy([
        {
          name: `${pad}${AHSA.repeat(200)}`,
          description: 'Astral name.',
          parameters: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
          output: { type: 'string' },
        },
      ])
      // The base is `${camelCase(name)}Args` capped to 120 code units, so the
      // `Args` suffix itself is cut off here; match the declaration instead.
      return /^class (.+)\(TypedDict\):$/mu.exec(text)![1]!
    }
    // Each character is 2 code units, so an unpadded name fills the cap with 60
    // whole characters; one ASCII character of padding puts the boundary inside
    // the 60th pair, and that half is dropped rather than emitted.
    expect(className('')).toBe(AHSA.repeat(60))
    const padded = className('x')
    expect(padded).toBe(`X${AHSA.repeat(59)}`)
    expect(padded).toHaveLength(119)
  })

  it('normalizes the seam the Tool prefix creates, which the prefixed part alone does not cover', () => {
    // U+0301 COMBINING ACUTE ACCENT is XID_Continue but not XID_Start, so a name
    // headed by it takes the `Tool` prefix — and `Tool` ends in `l`, which
    // composes with it. Normalizing only the part being prefixed would emit
    // `Tool` + U+0301, which CPython compiles as `Too` + U+013A: the class
    // the SDK declares would not be the class the interpreter defines. Every
    // code point below is an escape — the two forms render identically.
    const text = renderToolsSdkPy([
      {
        name: '\u0301abc',
        description: 'Combining-mark head.',
        parameters: { type: 'object', additionalProperties: false, properties: { q: { type: 'string' } }, required: ['q'] },
        output: { type: 'string' },
      },
    ])
    expect(text).toContain('class Too\u013AabcArgs(TypedDict):')
    expect(text).toContain('# tools["\u0301abc"](args: Too\u013AabcArgs) -> str')
    expect(text).not.toContain('Tool\u0301')
  })

  it('normalizes a class-name join where two separately stable segments compose', () => {
    // Hangul jamo compose ACROSS the join `childClassName` makes: the parent
    // base ends in U+1100 (L jamo) and the child segment starts with U+1161 (V
    // jamo), each NFKC-stable alone, together U+AC00. Unnormalized, the declared
    // name differs from the compiled symbol, and two byte-distinct names can
    // fold onto one — `usedClassNames` dedupes by raw bytes, so the collision
    // counter never sees it and the later declaration shadows the earlier one
    // under CPython. Escapes again, for the same reason as above.
    const text = renderToolsSdkPy([
      {
        name: 'x',
        description: 'Jamo field names.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['\uAC00\u1100'],
          properties: {
            '\uAC00\u1100': {
              type: 'object',
              additionalProperties: false,
              required: ['\u1161x'],
              properties: {
                '\u1161x': { type: 'object', additionalProperties: false, properties: { q: { type: 'string' } } },
              },
            },
          },
        },
        output: { type: 'string' },
      },
    ])
    // The join is `XArgs` + U+AC00 U+1100 followed by U+1161 `x`, whose
    // trailing L+V pair composes into a second U+AC00.
    expect(text).toContain('class XArgs\uAC00\uAC00x(TypedDict):')
    expect(text).toContain('    \u1161x: XArgs\uAC00\uAC00x')
    expect(text).not.toContain('\u1100\u1161')
    // The level above it is a join that composes nothing (LV + L), so it stays
    // byte-identical — normalizing is not silently rewriting every name.
    expect(text).toContain('class XArgs\uAC00\u1100(TypedDict):')
  })

  it('routes a fold collision through the counter that raw-byte dedup would miss', () => {
    // The other half of the `childClassName` normalization: two joins that are
    // byte-distinct before NFKC and identical after. Field `\uAC00` allocates
    // `XArgs\uAC00`; the sibling `\u1100` allocates `XArgs\u1100`, and ITS child
    // `\u1161` joins to `XArgs\u1100\u1161` — the same `XArgs\uAC00` once composed.
    // Normalizing at the join is what lets `usedClassNames`, which dedupes by raw
    // bytes, see the collision at all; unnormalized, both would be declared and
    // CPython would compile the second as a shadow of the first.
    const text = renderToolsSdkPy([
      {
        name: 'x',
        description: 'Colliding jamo joins.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['\uAC00', '\u1100'],
          properties: {
            '\uAC00': { type: 'object', additionalProperties: false, required: ['q'], properties: { q: { type: 'string' } } },
            '\u1100': {
              type: 'object',
              additionalProperties: false,
              required: ['\u1161'],
              properties: {
                '\u1161': { type: 'object', additionalProperties: false, required: ['q'], properties: { q: { type: 'string' } } },
              },
            },
          },
        },
        output: { type: 'string' },
      },
    ])
    expect(text).toContain('class XArgs\uAC00(TypedDict):')
    expect(text).toContain('class XArgs\uAC002(TypedDict):')
    expect(text).toContain('    \u1161: XArgs\uAC002')
  })

  it('names both branches of a oneOf of objects on the argument side', () => {
    // The output side is pinned elsewhere; arguments reach the same
    // `childClassName(frame.className, index + 1)` path, and the annotation is
    // the union of the two derived names rather than a degraded dict.
    const text = renderToolsSdkPy([
      {
        name: 'x',
        description: 'Union arguments.',
        parameters: {
          oneOf: [
            { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } },
            { type: 'object', additionalProperties: false, required: ['b'], properties: { b: { type: 'number' } } },
          ],
        },
        output: { type: 'string' },
      },
    ])
    expect(text).toContain('class XArgs1(TypedDict):')
    expect(text).toContain('class XArgs2(TypedDict):')
    expect(text).toContain('async def x(self, args: XArgs1 | XArgs2) -> str:')
  })

  it('declares a closed empty object with omitted properties as an empty TypedDict, not dict[str, Any]', () => {
    // `{ type: 'object', additionalProperties: false }` with no `properties`
    // is a closed empty object — no key accepted — exactly as the validator
    // and the TS renderer read it. It must not degrade to a permissive dict.
    const tool: ToolSdkSchema = {
      name: 'closed',
      description: 'Closed empty object with omitted properties.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { inner: { type: 'object', additionalProperties: false } },
        required: ['inner'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toMatch(/class ClosedArgsInner\(TypedDict\):\n    pass/)
    expect(text).toContain('inner: ClosedArgsInner')
    expect(text).not.toContain('dict[str, Any]')
  })

  it('degrades an open object with omitted properties to dict[str, Any]', () => {
    // An OPEN empty object (default additionalProperties) is any dict.
    const type = jsonSchemaToPy({ type: 'object', properties: {} })
    expect(type).toBe('dict[str, Any]')
    expect(jsonSchemaToPy({ type: 'object' })).toBe('dict[str, Any]')
  })

  it('renders docstrings for descriptions and orders emissions lexicographically', () => {
    const text = renderToolsSdkPy([bash, exotic])
    expect(text).toContain('"""Run a shell command."""')
    // Descriptions on subscript names ride as a comment beside their entry.
    expect(text).toContain('# tools["my-mcp.tool"]')
    expect(text).toContain('#   Exotic name.')
    // Lexicographic: `bash` before `my-mcp.tool`.
    expect(text.indexOf('async def bash')).toBeLessThan(text.indexOf('# tools["my-mcp.tool"]'))
  })

  it('places a docstring as the first statement of its own method body', () => {
    // Python attaches a docstring to a function only when it is that
    // function's first statement. Above the `async def` the first one would
    // document the `Tools` class and every later one would be a dead
    // expression, so each method must open its body with its own docstring.
    const second: ToolSdkSchema = {
      name: 'zzz',
      description: 'Second by name.',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const lines = renderToolsSdkPy([bash, second]).split('\n')
    for (const [name, doc] of [['bash', 'Run a shell command.'], ['zzz', 'Second by name.']]) {
      const signature = lines.findIndex(line => line.startsWith(`${' '.repeat(4)}async def ${name}(`))
      expect(signature).toBeGreaterThan(-1)
      // Ends in `:`, not the `: ...` stub — a docstring IS the whole body.
      expect(lines[signature]?.endsWith(':')).toBe(true)
      expect(lines[signature + 1]).toBe(`${' '.repeat(8)}"""${doc}"""`)
    }
    // No docstring is left floating at class-body indentation.
    expect(lines.filter(line => line.startsWith(`${' '.repeat(4)}"""`))).toEqual([])
  })

  it('orders subscript entries against methods by name, not by member kind', () => {
    // `a-tool` sorts before `z`, so the subscript comment must precede the
    // method: one ordered stream, not methods-then-comments.
    const noArgs = parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>
    const text = renderToolsSdkPy([
      { name: 'z', description: 'Last by name.', parameters: noArgs, output: { type: 'string' } },
      { name: 'a-tool', description: 'First by name.', parameters: noArgs, output: { type: 'string' } },
    ])
    expect(text.indexOf('# tools["a-tool"]')).toBeLessThan(text.indexOf('async def z'))
    // The interleaved comment does not disturb the class body: `z` still parses
    // as the statement that keeps `pass` out.
    expect(text).not.toContain(`${' '.repeat(4)}pass`)
  })

  it('is deterministic: byte-identical output regardless of input order or duplication', () => {
    expect(renderToolsSdkPy([bash, exotic])).toBe(renderToolsSdkPy([exotic, bash]))
    expect(renderToolsSdkPy([bash, bash])).toBe(renderToolsSdkPy([bash, bash]))
  })

  it('renders a pass body and a minimal import for an empty tool set', () => {
    const text = renderToolsSdkPy([])
    expect(text).toContain('class Tools(Protocol):')
    expect(text).toContain('    pass')
    // Nothing but the protocol is used, so the import line is just Protocol.
    expect(text).toContain('from typing import Protocol')
  })

  it('omits the docstring/comment when a schema has no description', () => {
    const undescribedIdentifier: ToolSdkSchema = {
      name: 'plain',
      description: '',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const undescribedExotic: ToolSdkSchema = {
      name: 'weird-name',
      description: '',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([undescribedIdentifier, undescribedExotic])
    // Identifier method appears without a docstring in its body — hence the
    // `: ...` stub, which a documented method replaces with the docstring.
    expect(text).toContain('async def plain(self, args: dict[str, Any]) -> str: ...')
    expect(text).not.toContain('"""')
    // Subscript entry appears without the "#   ..." description follow-up.
    expect(text).toContain('# tools["weird-name"]')
    expect(text.split('\n').every(line => !line.startsWith('    #   '))).toBe(true)
    // A whitespace-only description collapses to nothing and is treated as
    // absent: no empty `""""""` docstring, no bare `#   ` line.
    const blank = renderToolsSdkPy([
      { ...undescribedIdentifier, description: ' \t\n ' },
      { ...undescribedExotic, description: '   ' },
    ])
    expect(blank).toBe(text)
  })

  it('marks an open object TypedDict and declares a closed empty object', () => {
    const t: ToolSdkSchema = {
      name: 'openness',
      description: '',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          open: { type: 'object', additionalProperties: true, properties: { x: { type: 'string' } }, required: ['x'] },
          closedEmpty: { type: 'object', additionalProperties: false, properties: {} },
        },
        required: ['open', 'closedEmpty'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([t])
    // The open nested object carries the in-band openness note...
    expect(text).toContain('class OpennessArgsOpen(TypedDict):')
    expect(text).toMatch(/class OpennessArgsOpen\(TypedDict\):\n    x: str\n    # Additional keys beyond those declared are allowed\./)
    // ...the closed root does not...
    expect(text).toMatch(/class OpennessArgs\(TypedDict\):\n    open: OpennessArgsOpen\n    closedEmpty: OpennessArgsClosedEmpty\n\n/)
    // ...and a closed EMPTY object declares an empty TypedDict rather than
    // degrading to dict[str, Any] (which would falsely accept any keys).
    expect(text).toMatch(/class OpennessArgsClosedEmpty\(TypedDict\):\n    pass/)
    expect(text).toContain('closedEmpty: OpennessArgsClosedEmpty')
  })

  it('renders a deeply nested array schema without exhausting the call stack, capped at CPython\'s bracket limit', () => {
    // The registry supports depth-unbounded schemas; the renderer must not
    // reintroduce a recursion limit during prompt assembly. It must also not
    // emit more open brackets than CPython's tokenizer accepts (200), so the
    // chain degrades to `Any` at MAX_LIST_NESTING instead of rendering an SDK
    // block that is not valid Python.
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 20000; i++) deep = { type: 'array', items: deep }
    const type = jsonSchemaToPy(deep)
    expect(type.startsWith('list[list[')).toBe(true)
    expect(type.endsWith(']]')).toBe(true)
    // 180 `list[` levels around `Any`, not 20000 around `str`.
    expect(type).toBe(`${'list['.repeat(180)}Any${']'.repeat(180)}`)
    expect(type.split('[').length - 1).toBeLessThan(200)
  })

  it('keeps a chain just under the nesting cap exact, and restarts nesting per TypedDict field', () => {
    // 179 levels still render the real item type: the cap degrades only what
    // would not parse.
    let under: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 179; i++) under = { type: 'array', items: under }
    expect(jsonSchemaToPy(under)).toBe(`${'list['.repeat(179)}str${']'.repeat(179)}`)
    // A field annotation is a fresh logical line, so a 179-deep chain reached
    // THROUGH an object field is unaffected by the depth spent on the object.
    const tool: ToolSdkSchema = {
      name: 'deep_field',
      description: 'Deep array under a field.',
      parameters: { type: 'object', additionalProperties: false, properties: { rows: under }, required: ['rows'] },
      output: { type: 'string' },
    }
    expect(renderToolsSdkPy([tool])).toContain(`    rows: ${'list['.repeat(179)}str${']'.repeat(179)}`)
  })

  it('caps the argument annotation, the site whose enclosing paren stays open', () => {
    // The worst of the three emission sites: the parameter list's `(` is still
    // open around this annotation, so 180 `list[` plus the innermost bracket
    // plus that paren is 182 of CPython's 200. Only a raw `register()` whose
    // `parameters` is an array reached from the root through `oneOf` arms
    // alone gets there — the root array itself, or one under any depth of
    // unions, since an arm inherits the enclosing depth unchanged. An object
    // ancestor takes it out of this case: its fields restart at the 181 site.
    // `defineTool` compiles an object root, whose annotation is a bare
    // TypedDict name or a one-bracket `dict[str, Any]`, never a chain.
    const rooted = (depth: number): ToolSdkSchema => {
      let schema: Record<string, unknown> = { type: 'string', const: 'x' }
      for (let i = 0; i < depth; i++) schema = { type: 'array', items: schema }
      return { name: 'rooted', description: 'Array-rooted parameters.', parameters: schema, output: { type: 'string' } }
    }
    // Exactly at the cap with a scalar underneath is the worst case itself: the
    // chain's root frame starts at `listDepth: 0` here, so all 180 `list[`
    // still emit and the innermost `Literal[` is reached rather than degraded.
    const worst = renderToolsSdkPy([rooted(180)])
    expect(worst).toContain(`async def rooted(self, args: ${'list['.repeat(180)}Literal["x"]${']'.repeat(180)}) -> str:`)
    const annotation = worst.split('async def rooted(self, args: ')[1]!.split(') -> str:')[0]!
    // 181 brackets on the annotation plus the still-open parameter-list paren,
    // the 182 the cap is chosen against.
    expect(annotation.split('[').length - 1).toBe(181)
    // One array deeper is where the degradation lands, and it lands on the item
    // rather than on another `list[`, so the count cannot grow past that.
    expect(renderToolsSdkPy([rooted(181)]))
      .toContain(`async def rooted(self, args: ${'list['.repeat(180)}Any${']'.repeat(180)}) -> str:`)
    // A union spine reaches the same 182, at any number of arms deep: each arm
    // inherits the enclosing depth because `A | B` opens nothing, so the chain
    // under the innermost one still starts at 0. Three unions here, to pin that
    // it is the whole `oneOf`-only path and not just a single root union.
    let spine: Record<string, unknown> = rooted(180).parameters
    for (let i = 0; i < 3; i++) spine = { oneOf: [spine, { type: 'string' }] }
    const text = renderToolsSdkPy([{ ...rooted(180), parameters: spine }])
    const chain = `${'list['.repeat(180)}Literal["x"]${']'.repeat(180)}`
    expect(text).toContain(`args: ${chain} | str | str | str) -> str:`)
    expect(text.split('async def rooted(self, args: ')[1]!.split(') -> str:')[0]!.split('[').length - 1).toBe(181)
    // An object ancestor is the boundary of that path: the field it declares is
    // a class-body line, so the same chain lands on the 181 site instead.
    const boxed = renderToolsSdkPy([
      {
        ...rooted(180),
        parameters: { type: 'object', properties: { rows: rooted(180).parameters }, required: ['rows'] },
      },
    ])
    expect(boxed).toContain(`    rows: ${'list['.repeat(179)}Any${']'.repeat(179)}`)
  })

  it('renders a deeply nested oneOf chain in linear time (no per-level re-materialization)', () => {
    // Each level is a two-branch oneOf whose first branch recurses; joining the
    // accumulated union string at every level would be Theta(depth^2). At this
    // depth the quadratic path (~100,000^2 char copies) blows past vitest's 5s
    // default, so this fails loud on a regression; the `+`/ConsString path is
    // milliseconds. (Guard the depth explicitly so the assertions stay exact.)
    // The resulting chain is intentionally uncapped, unlike list nesting: it is
    // grammatically valid Python at any length, and only CPython's `compile()`
    // recursion would reject it — see the `oneOf` arm in py-types.ts.
    const depth = 100000
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < depth; i++) deep = { oneOf: [deep, { type: 'null' }] }
    const type = jsonSchemaToPy(deep)
    expect(type.startsWith('str | None')).toBe(true)
    expect(type.endsWith(' | None')).toBe(true)
    expect(type.length).toBe('str'.length + ' | None'.length * depth)
  })

  it('names a deep oneOf-of-object chain in linear time (bounded propagated class names)', () => {
    // Every level is a oneOf whose SECOND branch is a named object (a closed
    // empty TypedDict) and whose first branch recurses — so every level has an
    // object node, each propagating a class name one segment longer. Without a
    // propagation cap, allocateClassName slices an ever-longer rope at every
    // level → Theta(depth^2) (~9.5s at this depth, past the 5s default);
    // childClassName caps the base so it stays linear (~ms). Assertions are
    // shape-based but the depth is the tripwire: a regression times out.
    const depth = 60000
    let deep: Record<string, unknown> = { type: 'object', additionalProperties: false, properties: {} }
    for (let i = 0; i < depth; i++) {
      deep = { oneOf: [deep, { type: 'object', additionalProperties: false, properties: {} }] }
    }
    const tool: ToolSdkSchema = { name: 'deep', description: 'Deep oneOf-object chain.', parameters: { type: 'object', additionalProperties: false, properties: { root: deep }, required: ['root'] }, output: { type: 'string' } }
    const text = renderToolsSdkPy([tool])
    // No emitted class name exceeds the cap (plus a short collision suffix).
    const longest = [...text.matchAll(/^class (\w+)\(TypedDict\):/gm)].reduce((max, m) => Math.max(max, m[1]?.length ?? 0), 0)
    expect(longest).toBeLessThanOrEqual(140)
    expect(text).toContain('class Tools(Protocol):')
  })

  it('caps the class name for a tool whose name exceeds the base length limit', () => {
    // The root class base is `${CamelCase(name)}Args`; a very long tool name
    // makes it exceed MAX_CLASS_NAME_BASE, so allocateClassName caps it.
    const longName = `x_${'a'.repeat(200)}`
    const tool: ToolSdkSchema = {
      name: longName,
      description: 'Long name.',
      parameters: { type: 'object', additionalProperties: false, properties: { f: { type: 'string' } }, required: ['f'] },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    const longest = [...text.matchAll(/^class (\w+)\(TypedDict\):/gm)].reduce((max, m) => Math.max(max, m[1]?.length ?? 0), 0)
    expect(longest).toBeLessThanOrEqual(140)
    expect(text).toContain('class Tools(Protocol):')
  })

  it('emits pass for a subscript-only tool set (comments are not statements)', () => {
    const t: ToolSdkSchema = {
      name: 'my-exotic.tool',
      description: '',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([t])
    // The class body must contain a statement before the subscript comments.
    expect(text).toMatch(/class Tools\(Protocol\):\n    pass\n    # tools\["my-exotic\.tool"\]/)
  })

  it('degrades an object whose field would be name-mangled (__token) to dict[str, Any]', () => {
    // Class-syntax TypedDict mangles a leading-double-underscore non-dunder
    // annotation to _ClassName__token — a different JSON key than the schema.
    const t: ToolSdkSchema = {
      name: 'mangler',
      description: '',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { __token: { type: 'string' } },
        required: ['__token'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([t])
    expect(text).toContain('async def mangler(self, args: dict[str, Any]) -> str: ...')
    expect(text).not.toContain('__token:')
    // Dunder-form fields (__meta__) are NOT mangled and stay expressible.
    const dunder: ToolSdkSchema = {
      name: 'dunder',
      description: '',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { __meta__: { type: 'string' } },
        required: ['__meta__'],
      },
      output: { type: 'string' },
    }
    expect(renderToolsSdkPy([dunder])).toContain('__meta__: str')
  })

  it('degrades an object with a __debug__ field, which CPython refuses to assign', () => {
    // `__debug__` is a legal identifier and dunder-form, so it clears both the
    // identifier rule and the name-mangling rule, but CPython rejects the
    // annotation at COMPILE time (`SyntaxError: cannot assign to __debug__`) —
    // and this block is PTC mode's only SDK, so it must always parse.
    const t: ToolSdkSchema = {
      name: 'debugger',
      description: '',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { __debug__: { type: 'string' } },
        required: ['__debug__'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([t])
    expect(text).toContain('async def debugger(self, args: dict[str, Any]) -> str: ...')
    expect(text).not.toContain('__debug__')
  })

  it('routes every underscore-leading tool name to subscript access', () => {
    // `_foo` and `__meta__` are both legal Python attributes, unlike an exotic
    // name or a hard keyword, yet the whole underscore family goes to
    // `tools[name]` under one rule. Only some forms actually break — `__token`
    // name-mangles at the CALL SITE inside the model's own class, and a dunder
    // that exists on `object` (`__class__`) resolves before the proxy's
    // __getattr__ runs — so the family rule is what routes `_foo` and
    // `__meta__`, not a defect in those two names.
    const make = (name: string): ToolSdkSchema => ({
      name,
      description: 'Leading underscore.',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    })
    const text = renderToolsSdkPy([make('_foo'), make('__meta__'), make('__token')])
    for (const name of ['_foo', '__meta__', '__token']) {
      expect(text).toContain(`# tools[${JSON.stringify(name)}](args: dict[str, Any]) -> str`)
      expect(text).not.toContain(`async def ${name}(`)
    }
    // No method emitted at all, so the class body needs the explicit `pass`.
    expect(text).toContain('    pass\n')
  })

  it('quotes a tool name through the same JSON.stringify the Literal path depends on', () => {
    // A lone surrogate is reachable in a name — `"\ud800"` survives
    // `JSON.parse` of MCP wire JSON — and this path has no UNPRINTABLE /
    // LONE_SURROGATE fallback behind it, only ES2019 well-formed
    // stringification. Raw, it would make the whole SDK block uncompilable,
    // exactly as on the `Literal[...]` path.
    const text = renderToolsSdkPy([
      {
        name: 'a\ud800b',
        description: 'Lone surrogate in the name.',
        parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
        output: { type: 'string' },
      },
    ])
    expect(text).toContain(String.raw`# tools["a\ud800b"](args: dict[str, Any]) -> str`)
    expect(text).not.toContain('\ud800')
  })

  it('escapes quotes and backslashes in descriptions so the docstring stays valid Python', () => {
    // A description ending in `"` or an odd backslash would otherwise merge
    // with (or escape) the closing triple quote — and this block is Code
    // Mode's only SDK, so it must always parse.
    const trailingQuote = renderToolsSdkPy([described('ends in a quote"')])
    expect(trailingQuote).toContain(String.raw`"""ends in a quote\""""`)
    const trailingBackslash = renderToolsSdkPy([described('ends in a backslash\\')])
    expect(trailingBackslash).toContain(String.raw`"""ends in a backslash\\"""`)
    const tripleQuote = renderToolsSdkPy([described('contains """ triple quote')])
    expect(tripleQuote).toContain(String.raw`"""contains \"\"\" triple quote"""`)
  })

  it('escapes unprintable control characters, which CPython refuses inside source at all', () => {
    // `compile()` raises `SyntaxError: source code string cannot contain null
    // bytes` for a NUL ANYWHERE in the source text, including inside a string
    // literal or a comment, so a NUL that survives normalization into a
    // docstring or a `#` field comment stops this block — PTC mode's only SDK —
    // from parsing at all. The whitespace collapse does not remove it (a NUL is
    // not whitespace). Rendering it as a visible escape keeps the source
    // parseable and still shows the model what the schema said.
    const nul = renderToolsSdkPy([described('before\u0000after')])
    // Both emission sites: the method docstring and the `#` field comment. The
    // docstring's backslash is doubled by the same escaping that keeps a literal
    // backslash from escaping the closing triple quote, so Python parses it back
    // to the visible `\x00` the comment shows directly. Neither carries the byte.
    expect(nul).not.toContain('\u0000')
    expect(nul).toContain(String.raw`"""before\\x00after"""`)
    expect(nul).toContain(String.raw`# before\x00after`)
    // The other C0 controls and DEL escape on the same path. Tab, newline and
    // carriage return never reach it: the whitespace collapse folds them to a
    // space first.
    const others = renderToolsSdkPy([described('bell\u0007esc\u001bdel\u007f')])
    expect(others).toContain(String.raw`bell\x07esc\x1bdel\x7f`)
    expect(renderToolsSdkPy([described('tab\tnewline\ncr\r')])).toContain('"""tab newline cr"""')
    // No C1 control is ECMAScript whitespace (TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus
    // LF/CR/LS/PS), so the collapse folds none of U+0080 to U+009F and the
    // escape is what keeps them out of the docstring, where they would be
    // invisible. NBSP, which IS whitespace, folds instead. Windows-1252 bytes
    // 0x80 to 0x9F decoded as Latin-1 land exactly here.
    const nel = renderToolsSdkPy([described('a\u0085b')])
    expect(nel).not.toContain('\u0085')
    expect(nel).toContain(String.raw`# a\x85b`)
    const c1 = renderToolsSdkPy([described('csi\u009bst\u009cend\u009f')])
    expect(c1).toContain(String.raw`csi\x9bst\x9cend\x9f`)
    expect(renderToolsSdkPy([described('nb\u00a0sp')])).toContain('"""nb sp"""')
    // `Cf` formatting characters pass through by category, not by
    // addressability — U+00AD would fit `\xNN`, the rest would need a second
    // form. They terminate neither a Python string literal nor a `#` comment,
    // so the block stays parseable with the code point intact.
    expect(renderToolsSdkPy([described('zero\u200bwidth')])).toContain('"""zero\u200bwidth"""')
    // Whitespace around a surviving control character is not an absent
    // description. The escape's output is non-whitespace ASCII and the escaped
    // sets are disjoint from what `trim()` strips, so the two operations touch
    // different characters and their order is unobservable.
    expect(renderToolsSdkPy([described(' \u0085 ')])).toContain(String.raw`# \x85`)
  })

  it('escapes unpaired surrogates, which make the source impossible to encode', () => {
    // This is the NUL case, not the invisible-character case: Python source
    // must be UTF-8-encodable, and `compile()` raises `UnicodeEncodeError:
    // surrogates not allowed` for a lone surrogate in a string literal and in a
    // `#` comment alike, so one would stop this block — PTC mode's only SDK —
    // from parsing. A wire description reaches it: `JSON.parse` on a `"\ud800"`
    // escape yields exactly this code point.
    const high = renderToolsSdkPy([described('a\ud800b')])
    expect(high).not.toContain('\ud800')
    expect(high).toContain(String.raw`# a\ud800b`)
    expect(high).toContain(String.raw`"""a\\ud800b"""`)
    // A lone LOW surrogate is just as unencodable, and `\xNN` reaches neither.
    expect(renderToolsSdkPy([described('a\udfffb')])).toContain(String.raw`# a\udfffb`)
    // A well-formed pair is ONE astral code point, not two surrogates — the
    // regex's `u` flag is what draws that line, so an emoji survives intact.
    expect(renderToolsSdkPy([described('emoji \u{1f600} ok')])).toContain('"""emoji \u{1f600} ok"""')
  })
})
