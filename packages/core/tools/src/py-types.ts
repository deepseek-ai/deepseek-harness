/**
 * PTC mode codegen — Python flavor. The pure projection from registered tool schemas to the
 * Python SDK text the model programs against under `runtime.language === 'python'`. Sibling of
 * {@link ./ts-types.ts | ts-types.ts}; the two files are two projections of the same registry
 * store, keyed by the loaded {@link @deepseek-ai/dsh-ptc-runtime#PtcRuntime.language | PTC
 * runtime's language}.
 *
 * Under `mode: 'ptc'` the native tool schemas are omitted from the request, so this generated
 * SDK is the model's ONLY source for each tool's argument names, required fields, types,
 * descriptions, and canonical output shapes; under `mode: 'both'` the native schemas ship
 * alongside it and it is one of two. Object-shaped arguments and outputs therefore render as one
 * named `TypedDict` per tool (and per nested object), not an opaque `dict[str, Any]`, so the
 * shape survives into the program under the mode that has nothing else to carry it.
 * @module @deepseek-ai/dsh-tools/src/py-types
 */

import { assertSupportedJsonSchema } from './json-schema.ts'
import type { JsonSchemaNode, JsonSchemaScalar } from './json-schema.ts'
import type { ToolSdkSchema } from './ts-types.ts'

/**
 * The reference grammar's `xid_start xid_continue*` — the set
 * `str.isidentifier()` accepts on a CPython whose Unicode tables match the
 * engine's. See {@link isBareIdentifier} for what a version skew does.
 */
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u

/**
 * Whether a name can be emitted as a bare Python identifier rather than
 * routed to the subscript/`dict[str, Any]` path.
 *
 * Python identifiers are not ASCII: `路径` is as legal a field name as `path`,
 * and rejecting it would degrade the whole enclosing object, dropping every
 * field's name, requiredness, and type — information whose only source under
 * `mode: 'ptc'` is this generated text.
 *
 * NFKC stability is a second and separate condition, because CPython
 * normalizes identifiers at compile time while JSON keys are compared as
 * written: `ﬁeld` would be declared and reachable as `field`, so the SDK would
 * advertise a key under a spelling the harness never accepts, and two keys
 * that normalize together would collapse into one declaration. Those names
 * take the subscript path, which carries their exact bytes.
 *
 * `IDENTIFIER` matches `str.isidentifier()` (measured on Node 22.23.1 vs
 * CPython 3.9.6 tables): the equivalence holds inside the two versions' shared
 * tables, and the skew characters below are exactly where that pair diverges.
 * The predicate as a whole is deliberately stricter than `isidentifier()`,
 * which does not test NFKC stability: `'ﬁeld'.isidentifier()` is True and
 * this returns false.
 *
 * Both conditions are evaluated against the ENGINE's Unicode tables, and the
 * two sides are versioned independently — `\p{XID_Start}`/`\p{XID_Continue}`
 * follow the running engine (Node 22.23.1 reports Unicode 17.0) while CPython
 * follows its own (3.9.6 reports 13.0.0). The skew is not symmetric. A CPython
 * older than the engine is the dangerous direction: a character added to either
 * property since its tables (U+10570 Vithkuqi and U+1E290 Toto, 14.0; U+1E4D0
 * Nag Mundari, 15.0; U+1C89 Cyrillic TJE, 16.0 — ages per `DerivedAge.txt`; all
 * four are NFKC-stable and accepted here, and all four are `Cn` on that 3.9.6,
 * which rejects them) is emitted bare and its tokenizer refuses the character,
 * taking the whole SDK block down — the same parseability invariant
 * {@link UNPRINTABLE}, {@link LONE_SURROGATE} and {@link MAX_LIST_NESTING}
 * exist for. Both properties carry it: a character added only to `XID_Continue`
 * passes the trailing `\p{XID_Continue}*` in a tail position and fails the same
 * way — U+200C ZWNJ and U+200D ZWJ are that case, gaining `XID_Continue` in UCD
 * 15.1 and absent from it in 13.0.0, 14.0.0 and 15.0.0, so `a\u{200C}b` is
 * emitted bare here while `isidentifier()` is False on 3.9.6 and on 3.12.13
 * (15.0.0). A CPython newer than the engine only routes a legal name to the
 * subscript/`dict[str, Any]` path: less readable, still correct. The NFKC
 * condition reduces to the same skew, since normalization stability guarantees
 * an assigned character's normalization never changes afterwards.
 *
 * This predicate is not the only reader of engine tables. {@link camelCase}
 * reads them at three further points — its split set, its head test, and its
 * `toUpperCase()` case mapping — and this predicate's verdict gates none of
 * them: a class name derived there reaches emitted text whenever any object
 * shape in the tool's schema declares a `TypedDict`, including for a tool this
 * predicate rejected. A tool named `zz-\u{1E4D0}x` with such parameters never
 * reaches the skew here (the `-` rejects it outright) yet emits `class
 * Zz\u{1E4D0}xArgs`, which that same 3.9.6 refuses — Nag Mundari arrived two
 * releases after its tables. The case mapping is a separate table rather than
 * an XID membership test, and it fails on names both conditions above accept:
 * `\u{019B}` is XID_Start and NFKC-stable, so this predicate accepts it and
 * `async def \u{019B}` compiles on 3.9.6, but Node uppercases it to
 * `\u{A7DC}` — unassigned in that CPython, whose own `.upper()` is the identity
 * here — and the declared `class \u{A7DC}Args` fails with `invalid
 * non-printable character U+A7DC`. Closing the exposure therefore covers all
 * four read points, not this predicate alone; it needs the target interpreter's
 * version, which the backend reporting `language: 'python'` owns; the
 * language-dispatch Agent Note records the deferral.
 *
 * The `ts-types` sibling keeps its own ASCII rule rather than sharing this
 * one: ECMAScript identifiers are a different set (`$`) and are never
 * normalized, so one predicate cannot be correct for both. ZWJ/ZWNJ are not
 * part of that difference — both sets carry them on the engine's tables; what
 * separates the two there is the CPython table version above.
 * @param name - the raw schema field or tool name.
 * @returns whether the name can be emitted bare.
 */
function isBareIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && name.normalize('NFKC') === name
}

/**
 * Python hard keywords: reserved everywhere, so a tool or field named
 * ``class`` or ``lambda`` is legal on the wire but not as an attribute
 * (``tools.class`` would be a SyntaxError in the model program) and not as a
 * class-syntax `TypedDict` field. Such a tool renders under subscript access
 * and such an object degrades to ``dict[str, Any]`` — the model still reaches
 * every tool and field without collisions.
 * Soft keywords (``match``, ``case``, ``type``, ``_`` — the language
 * reference's whole set) are deliberately ABSENT: each is special in exactly
 * one syntactic position — a statement head (``match``, ``type``), a ``match``
 * statement's clause head (``case``), or a pattern (``_``) — so ``match: str``
 * as a field and ``async def match(...)`` as a method are both legal, and
 * including them would needlessly degrade common search/regex tool fields to
 * ``dict[str, Any]``. Underscore-leading names are handled separately, not
 * here: a non-dunder ``__token`` name-mangles, a dunder present on
 * ``object``/``type`` resolves before the proxy hook, and implicit
 * special-method lookup bypasses the hook.
 */
const RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
  // Not a keyword, but CPython refuses to ASSIGN it at compile time
  // (`SyntaxError: cannot assign to __debug__`), which is what a TypedDict
  // field, a parameter name, and a keyword argument all are.
  '__debug__',
])

/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = ['Any', 'Literal', 'NotRequired', 'Protocol', 'TypedDict'] as const

/** `indent`-deep line prefix (four spaces per level to match PEP 8 output). */
function pad(indent: number): string {
  return '    '.repeat(indent)
}

/**
 * Collector threaded through {@link renderType}: the emitted `TypedDict` class
 * declarations (nested classes precede the parent that references them), the
 * class names already taken (for collision suffixing), a per-base collision
 * counter, and the `typing` symbols the render actually used.
 */
interface RenderState {
  readonly classes: string[]
  readonly usedClassNames: Set<string>
  /** Next collision counter per capped base, so allocation is amortized O(1) instead of rescanning from `2`. */
  readonly nextClassCounter: Map<string, number>
  readonly typing: Set<string>
}

/**
 * The `Cc` code points that survive the whitespace collapse in {@link describe}
 * and have no printable form: the C0 controls, DEL, and the C1 controls. Only
 * U+0009 to U+000D are absent, because ECMAScript `\s` already collapsed them —
 * `\s` is TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus LF/CR/LS/PS, so no C1 code point is
 * in it and the whole U+0080 to U+009F block reaches this rule intact. Those
 * are not hypothetical input: they are what Windows-1252 bytes 0x80 to 0x9F
 * (smart quotes, em dash) become when decoded as Latin-1.
 * CPython rejects source containing a NUL outright
 * (`SyntaxError: source code string cannot contain null bytes`), whether it
 * sits in a docstring or in a comment, so one such byte anywhere in a schema
 * description would make the whole generated SDK unparseable — under
 * `mode: 'ptc'`, the model's only declaration of the tools. The rest are
 * legal but invisible; escaping them with the same rule keeps the emitted text
 * readable and the treatment uniform.
 *
 * The boundary is the category, not per-code-point addressability: `\xNN`
 * addresses U+0000 to U+00FF, so one escape form covers `Cc` exactly. The
 * invisible `Cf` formatting characters pass through by design — of them only
 * U+00AD soft hyphen would fit `\xNN` at all, and escaping that one while
 * U+200B ZWSP, U+200E/U+200F bidi marks, and U+2060 word joiner passed through
 * would leave a rule that is neither category- nor addressability-shaped. The
 * whole family is legal in both consumers, since only LF and CR terminate a
 * Python string literal or a `#` comment. That set is the tokenizer's, not
 * `str.splitlines()`': NEL (U+0085), LS (U+2028), and PS (U+2029) split a
 * string at run time but do not end a physical line in source — measured on
 * CPython 3.9.6 and 3.12.13, each accepted in both positions with the value
 * round-tripping — so they are safe raw wherever they reach emitted text
 * unescaped, which for all three is `JSON.stringify`, at two call sites:
 * {@link pyScalar}'s literal path, and the subscript tool-name comment's own
 * call, which a name carrying any of them always reaches, none being
 * `XID_Continue`. The `description` path escapes NEL under the class above and
 * folds LS and PS in {@link describe}'s `\s+` collapse, both being `\s`.
 */
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g

/**
 * Unpaired surrogate code points, escaped by {@link describe} as `\uNNNN` —
 * its own form, since `\xNN` stops at U+00FF. The `u` flag is what makes this
 * the LONE ones: in Unicode mode a well-formed pair is a single astral code
 * point outside D800 to DFFF, so an emoji in a description survives untouched.
 *
 * This is the NUL case from {@link UNPRINTABLE}, not the invisible-character
 * case. Python source must be UTF-8-encodable and a lone surrogate is not, so
 * `compile()` raises `UnicodeEncodeError: surrogates not allowed` for one
 * anywhere in the text — measured on 3.9 for a string literal and for a `#`
 * comment alike. A raw or MCP tool description reaches this: `JSON.parse` on a
 * wire `"\ud800"` escape yields exactly such a code point.
 */
const LONE_SURROGATE = /[\ud800-\udfff]/gu

/**
 * The collapsed one-line `description` of a schema node (byte-stable across
 * formatting churn), or `undefined` when the node carries none. Every caller
 * passes an object — a validated property node, the `ToolSdkSchema` itself, or
 * the `{ description }` wrapper {@link docLines} synthesizes — so only the
 * description field needs guarding. A description that collapses
 * to nothing (empty, or whitespace only) is `undefined` too: it documents the
 * node no better than an absent one, and emitting it would leave an empty
 * `"""` docstring or a bare `#   ` line in the SDK. Only ECMAScript whitespace
 * folds, so a description of whitespace plus one surviving control character is
 * NOT absent: it collapses to that character's visible escape.
 *
 * Control characters left over after the whitespace collapse are rendered as
 * their `\xNN` escapes (see {@link UNPRINTABLE}) and unpaired surrogates as
 * their `\uNNNN` escapes (see {@link LONE_SURROGATE}); the escape's own backslash is
 * emitted literally by both consumers, since {@link docLines} doubles it into a
 * Python source escape and a `#` comment carries it verbatim.
 */
function describe(schema: object): string | undefined {
  const description = (schema as Record<string, unknown>).description
  if (typeof description !== 'string') return undefined
  const collapsed = description
    .replace(/\s+/g, ' ')
    .replace(UNPRINTABLE, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(LONE_SURROGATE, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .trim()
  return collapsed.length === 0 ? undefined : collapsed
}

/**
 * One-line docstring for a tool `description`, or no lines when there is none.
 * Backslashes are doubled first, every quote is escaped, and a trailing
 * backslash cannot survive: a description ending in `"` or an odd backslash
 * would otherwise merge with (or escape) the closing triple quote and make
 * the generated block — PTC mode's only SDK — syntactically invalid Python.
 */
function docLines(description: unknown, indent: number): string[] {
  const collapsed = describe({ description })
  if (collapsed === undefined) return []
  const escaped = collapsed.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return [`${pad(indent)}"""${escaped}"""`]
}

/**
 * CamelCase a name into a Python type identifier: non-identifier characters
 * split words, `_` splits too (it is `XID_Continue`, so the split set names it
 * explicitly), and a head that cannot start an identifier takes a `Tool`
 * prefix. Unicode survives, so a `路径` field yields `路径`-based class names
 * instead of collapsing to the bare prefix. A character that is not
 * `XID_Continue` splits even when it is a letter, so a name whose NFKC folding
 * would leave the identifier set is not carried through — the split set is the
 * grammar's, not an ASCII approximation of it.
 *
 * The result is NFKC-normalized: these names are generated, never matched
 * against a JSON key, so normalizing is free here and keeps what CPython
 * compiles identical to what is emitted — unlike {@link isBareIdentifier},
 * which must reject unstable names outright. Normalizing AFTER the prefix
 * decision is what makes that hold at the seam the prefix creates: `Tool` +
 * a combining-mark head composes there (`U+0301` gives `Tooĺ`, U+013A), so
 * normalizing only the un-prefixed part would emit a name CPython compiles to
 * a different symbol. The second call is idempotent on the un-prefixed arm.
 *
 * The split set, the head test, and `toUpperCase()` all read the engine's
 * Unicode tables, so this function carries the same version skew
 * {@link isBareIdentifier} documents, by paths independent of it: a class name
 * derived here reaches emitted text whenever any object shape in the tool's
 * schema declares a `TypedDict`, and the predicate's verdict on the tool name
 * does not gate that. The case mapping is the one that can fail on a name the
 * predicate accepted; the worked example is there.
 * @param raw - the schema field or tool name to derive from.
 * @returns a class-name segment safe to emit.
 */
function camelCase(raw: string): string {
  const joined = raw
    .split(/[^\p{XID_Continue}]+|_+/u)
    .filter(part => part.length > 0)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
    .normalize('NFKC')
  return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize('NFKC')
}

/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120

/**
 * Deepest `list[…]` nesting emitted into one annotation before the item type
 * degrades to `Any`. CPython's tokenizer rejects a logical line holding more
 * than 200 simultaneously-open brackets (`MAXLEVEL`, `SyntaxError: too many
 * nested parentheses`), so an array chain deeper than that would render an SDK
 * block that is not valid Python at all — the same failure the docstring
 * escaping in {@link docLines} exists to prevent. 180 leaves headroom for the
 * few brackets an annotation can add around the chain, all of which count
 * toward the same limit. Per emission site, counting brackets open at the
 * chain's innermost point:
 *
 * - Return annotation, `async def f(self, args: X) -> chain:` — 180 `list[`
 *   plus an innermost `Literal[`. The parameter list's `(` closed at the `)`
 *   before the `->`, so it is NOT open here: 181.
 * - TypedDict field, `field: NotRequired[chain]` — a class-body line with no
 *   other open bracket, and its children start at `listDepth: 1` to reserve
 *   the `NotRequired[`, so 179 `list[` plus `Literal[`: 181. Required fields
 *   share that start for uniformity, spending one level of representable depth
 *   on a bracket they never emit.
 * - Argument annotation, `async def f(self, args: chain) -> Y:` — the `(` IS
 *   still open around it: 180 `list[` plus `Literal[` plus the paren, 182, the
 *   worst case. Reachable only through a raw `register()` whose `parameters`
 *   is an array reached from the root through `oneOf` arms alone — the root
 *   array itself, or one nested under any depth of unions, since an arm
 *   inherits the enclosing depth unchanged (`A | B` opens no bracket). An
 *   object ancestor takes it out of this case: its fields restart the chain at
 *   the 181 site. `defineTool` compiles an object root, so the annotation is a
 *   bare TypedDict class name or a one-bracket `dict[str, Any]` when that
 *   object degrades — never a chain.
 *
 * A CPython grammar limit, not a deployment choice, so it is fixed rather than
 * configurable. The sibling `ts-types` renderer needs no counterpart: nothing
 * in the TypeScript grammar bounds nesting, and its SDK block is never type-
 * checked. Only bracket nesting counts — a `oneOf` renders as a flat `A | B`
 * chain and nested objects render as separate `class` statements, so neither
 * accumulates open brackets at any depth. The invariant this cap serves is
 * grammatical validity; see the `oneOf` arm in {@link renderType} for the one
 * interpreter limit deliberately left uncapped.
 */
const MAX_LIST_NESTING = 180

/**
 * Cap a class-name base at {@link MAX_CLASS_NAME_BASE} (see the callers for
 * why capping keeps the render linear). `slice` counts UTF-16 code units, so
 * an astral character straddling the boundary would be cut in half and leave a
 * lone surrogate — not an identifier character, and not even well-formed text;
 * drop it rather than emit it.
 */
function capClassNameBase(base: string): string {
  if (base.length <= MAX_CLASS_NAME_BASE) return base
  const capped = base.slice(0, MAX_CLASS_NAME_BASE)
  return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped
}

/**
 * Reserve a unique class name from a base, suffixing `2`, `3`, … on collision.
 * The base is capped at {@link MAX_CLASS_NAME_BASE} first: child class names
 * derive from their parent's allocated name (`ParentChild`), so an unbounded
 * schema of single-field objects would otherwise grow each name by one field
 * per level and the sum of all names to Θ(depth²). Capping the base keeps each
 * name — and the total emitted text — linear in depth. Collisions resume from
 * the per-base counter in `state.nextClassCounter` rather than rescanning from
 * `2`, so a deep chain sharing one capped base stays O(1) per allocation
 * (amortized) instead of Θ(depth²) in time.
 */
function allocateClassName(base: string, state: RenderState): string {
  const capped = capClassNameBase(base)
  let name = capped
  if (state.usedClassNames.has(name)) {
    let n = state.nextClassCounter.get(capped) ?? 2
    while (state.usedClassNames.has(`${capped}${n}`)) n++
    name = `${capped}${n}`
    state.nextClassCounter.set(capped, n + 1)
  }
  state.usedClassNames.add(name)
  return name
}

/**
 * Append a child-name segment to a parent class-name base, capping the result
 * at {@link MAX_CLASS_NAME_BASE}. Capping AT PROPAGATION (not only inside
 * {@link allocateClassName}) keeps each level O(1): a deep `oneOf`- or
 * object-chain would otherwise carry an ever-growing ConsString down the tree
 * and re-materialize it (via `.length`/`.slice`) at every level — Θ(depth²).
 * The bounded base plus the collision counter still yields unique names.
 *
 * The join is NFKC-normalized because both sides are separately normalized yet
 * their concatenation need not be: a base ending in a Hangul L jamo or LV
 * syllable composes with a following V or T jamo head (`가` + `ᆨ` gives `각`),
 * so the emitted class name would differ from the symbol CPython compiles, and
 * two byte-distinct names could fold onto one — `usedClassNames` dedupes by the
 * raw bytes, so the collision counter would not see it. Normalizing costs
 * O(cap + segment) per level, the same order as the `slice` it feeds. The other
 * two join points need no counterpart: `Args`/`Output` start with `A`/`O` and
 * {@link allocateClassName}'s suffix is digits, none of which compose backwards.
 */
function childClassName(base: string, segment: string): string {
  return capClassNameBase(`${base}${segment}`.normalize('NFKC'))
}

/**
 * Render one validated scalar as Python literal text (`True`/`False`,
 * JSON-quoted strings, bare numbers). `null` cannot reach here: the `null`
 * type renders directly as `None`, and the unified validator rejects a null
 * `const`/`enum` entry on every other scalar type.
 *
 * A beyond-safe-range integral number takes `BigInt` digits rather than
 * `String`: Python integers are arbitrary-precision, so the emitted digits ARE
 * the value the model programs against, and `String` can give a different
 * integer than the double holds (`2 ** 60` prints the rounded `...847000`, not
 * the exact `...846976`) or no integer literal at all (`1e21` prints `1e+21`).
 * `String`'s rounding is not a bug in it: `Number::toString` emits the shortest
 * decimal string that re-reads to the same double, then pads to the exponent
 * with zeros (1 significant digit for `1e20`, 16 for `2 ** 60`) — and when the
 * shortest string is shorter than the double's exact value, those padded digits
 * name an integer no double holds. Passing one back would have to cross the
 * argument boundary as a JSON number — a double again — so the SDK would
 * document a value no program can pass. `BigInt` needs no case split: where
 * `String` is already exact (`2 ** 53`, `1e20`) the two agree byte for byte,
 * and where it is not, `BigInt` is the exact one. The TS flavor needs no
 * counterpart at all: its literal is re-read by a JS parser back into the same
 * double.
 *
 * `JSON.stringify` is also what keeps this path's output parseable, and it is
 * the only thing that does. It covers both classes of hazard: the two kinds of
 * code point CPython refuses anywhere in source — NUL among the C0 controls,
 * and the whole D800–DFFF unpaired-surrogate block, escaped under ES2019
 * well-formed stringification, which the engines range guarantees — and the
 * ones that break this line in particular, a bare `"` closing the literal
 * early, a trailing odd backslash eating the closing quote, and a bare LF/CR
 * ending it before its terminator. The `description` path carries
 * {@link UNPRINTABLE} and {@link LONE_SURROGATE} because nothing quotes it,
 * and folds newlines in {@link describe}.
 *
 * That leans on a coincidence worth naming: every escape `JSON.stringify` can
 * emit (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) is also a Python
 * escape denoting the same character, so the emitted `Literal[...]` both
 * parses and decodes back to the value the schema declared. DEL, the C1
 * controls (NEL among them), and LS/PS (U+2028/U+2029) do reach it raw —
 * legal but invisible, byte-for-byte as in the TS flavor; escaping them is a
 * both-flavors change. Those last three are legal here for the reason
 * {@link UNPRINTABLE} records: they are `str.splitlines()` boundaries, not
 * tokenizer line terminators. The subscript tool-name comment quotes its name
 * through its own call to the same `JSON.stringify`, never through this
 * function, and inherits both halves — escapes and pass-throughs alike.
 */
function pyScalar(value: JsonSchemaScalar): string {
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return BigInt(value).toString()
  }
  return String(value)
}

/**
 * Render a validated scalar `const`/`enum` as `Literal[...]`, falling back to
 * the broad type. Deliberately deviates from PEP 586, which restricts `Literal`
 * parameters to int/bool/str/bytes/enum/None: a non-integral number
 * `const`/`enum` emits a float literal (`Literal[1.5]`) a strict checker would
 * reject. An integral one does not deviate — {@link pyScalar} emits int digits,
 * including for the beyond-safe-range values it widens through `BigInt`, and
 * PEP 586 admits int parameters. Harmless either way — the stub is advisory
 * prompt text, only required to parse — and keeping the exact value
 * communicates the constraint to the model.
 */
function renderConstrainedScalar(node: JsonSchemaNode, broad: string, state: RenderState): string {
  if (node.const !== undefined) {
    state.typing.add('Literal')
    return `Literal[${pyScalar(node.const)}]`
  }
  if (node.enum !== undefined) {
    state.typing.add('Literal')
    return `Literal[${node.enum.map(pyScalar).join(', ')}]`
  }
  return broad
}

/**
 * Map one JSON-Schema node to a Python type expression, threading `state` to
 * collect the `TypedDict` declarations and `typing` symbols a full render
 * needs. `className` is the name to give an object node with properties (and
 * the prefix for its nested objects). Handles every unified schema construct —
 * `oneOf` (→ `X | Y`), `const`/`enum` (→ `Literal[...]`), `integer` (→ `int`),
 * `null` (→ `None`) — and degrades an unsupported or malformed schema to `Any`
 * without throwing, the same trusted-after-validation stance as the sibling
 * {@link ./ts-types.ts | ts-types} renderer. {@link jsonSchemaToPy} is the
 * context-free entry point; this is the collecting core.
 */
function renderType(schema: unknown, className: string, state: RenderState): string {
  interface Frame {
    // A validated JSON-schema node past the root `assertSupportedJsonSchema`
    // (the root frame's schema is asserted before any frame is built), so the
    // walk reads its fields without casts — the same typed-frame shape as the
    // sibling ts-types renderer.
    schema: JsonSchemaNode
    className: string
    phase: 'start' | 'children'
    kind?: 'oneOf' | 'array' | 'typeddict'
    node?: JsonSchemaNode
    /** Open `list[` brackets enclosing this node in the annotation being built ({@link MAX_LIST_NESTING}). */
    listDepth: number
    children: { schema: JsonSchemaNode; className: string; listDepth: number }[]
    childIndex: number
    childTypes: string[]
    entries: [string, JsonSchemaNode][]
    allocated?: string
  }
  const newFrame = (schema: JsonSchemaNode, className: string, listDepth: number): Frame =>
    ({ schema, className, phase: 'start', listDepth, children: [], childIndex: 0, childTypes: [], entries: [] })
  try {
    // Validate the WHOLE tree once, then trust it — the same contract the
    // sibling ts-types renderer follows at a typed same-process boundary. Every
    // node past this point is a validated JSON-schema node, so the walk reads
    // its fields without re-checking. An unsupported or malformed schema throws
    // here (before anything is emitted) and degrades to `Any`, the Python
    // counterpart of the TS flavor's `unknown`.
    assertSupportedJsonSchema(schema)
    const frames: Frame[] = [newFrame(schema, className, 0)]
    let result: string | undefined
    /* jscpd:ignore-start -- the explicit-stack walk skeleton deliberately parallels
       ts-types.ts's renderSupportedSchema; the two sibling renderers keep symmetric shapes. */
    const finish = (type: string): void => {
      frames.pop()
      const parent = frames.at(-1)
      if (parent === undefined) result = type
      else parent.childTypes.push(type)
    }

    while (frames.length > 0) {
      const frame = frames.at(-1)
      /* v8 ignore next -- the loop condition guarantees a current frame. */
      if (frame === undefined) break

      if (frame.phase === 'children') {
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex]
          /* v8 ignore next -- childIndex is bounded by children.length. */
          if (child === undefined) throw new Error('missing python render child')
          frame.childIndex++
          frames.push(newFrame(child.schema, child.className, child.listDepth))
          continue
        }
        if (frame.kind === 'oneOf') {
          // Concatenate incrementally (template literal, not `Array.join`): V8
          // builds a lazy ConsString, so a deep oneOf chain materializes once
          // at the root instead of re-materializing the accumulated string at
          // every level (which `join` would, making it Θ(depth²)). This matches
          // the array arm's template-literal laziness and ts-types' composable-
          // document approach — the whole walk stays linear in schema depth.
          let union = ''
          for (const [index, childType] of frame.childTypes.entries()) {
            union = index === 0 ? childType : `${union} | ${childType}`
          }
          finish(union)
          continue
        }
        /* jscpd:ignore-end */
        if (frame.kind === 'array') {
          // `list[A | B]` needs no parentheses in Python. Array frames always
          // schedule exactly one child, so its type is present.
          /* v8 ignore next -- the ?? arm needs a childless array frame, which start never builds. */
          finish(`list[${frame.childTypes[0] ?? 'Any'}]`)
          continue
        }
        // typeddict: assemble AFTER the children so any nested class this one
        // references is already declared (declaration order = reference order).
        const node = frame.node
        const name = frame.allocated
        /* v8 ignore next -- typeddict frames always set node and allocated at start. */
        if (node === undefined || name === undefined) throw new Error('missing typeddict frame state')
        const required = new Set(node.required)
        const lines = [`class ${name}(TypedDict):`]
        for (let index = 0; index < frame.entries.length; index++) {
          const entry = frame.entries[index]
          const fieldType = frame.childTypes[index]
          /* v8 ignore next -- entries and childTypes correspond one-to-one. */
          if (entry === undefined || fieldType === undefined) throw new Error('missing typeddict field type')
          const [field, fieldSchema] = entry
          // The parent node passed assertSupportedJsonSchema, so every property
          // value is a validated schema node.
          const description = describe(fieldSchema)
          if (description !== undefined) lines.push(`${pad(1)}# ${description}`)
          if (required.has(field)) {
            lines.push(`${pad(1)}${field}: ${fieldType}`)
          } else {
            state.typing.add('NotRequired')
            lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`)
          }
        }
        // TypedDict syntax cannot express openness, so an open object states it
        // in-band: the annotation is advisory either way, and `mode: 'ptc'`
        // omits the native schemas, making this line the model's only signal
        // that extra keys are accepted.
        if (node.additionalProperties !== false) {
          lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`)
        }
        // A closed empty object still needs a class body (`pass`) to be valid
        // Python; the declared emptiness is the information.
        if (lines.length === 1) lines.push(`${pad(1)}pass`)
        state.classes.push(lines.join('\n'))
        finish(name)
        continue
      }

      frame.phase = 'children'
      const node = frame.schema
      if (node.oneOf !== undefined) {
        frame.kind = 'oneOf'
        // A union renders as `A | B` — no brackets of its own, so the branches
        // inherit the enclosing depth unchanged.
        //
        // Union LENGTH is deliberately uncapped, unlike list nesting. The two
        // limits are different in kind: >200 open brackets is a SyntaxError
        // from the tokenizer, so the text is not Python; a long `A | B | …`
        // chain is grammatically valid at any length and only defeats CPython's
        // C-recursion when `compile()` walks the left-nested BinOp spine
        // (measured: 1,000 branches compile, 5,000 raise RecursionError). This
        // block is prompt text — nothing compiles it — so that limit costs
        // nothing here, while capping would retire the deep-chain tests that
        // pin the walk's linear time and the class-name propagation cap. The
        // standard this renderer holds is grammatical validity, not
        // compilability under one interpreter's stack.
        frame.children = node.oneOf.map((branch, index) => ({ schema: branch, className: childClassName(frame.className, `${index + 1}`), listDepth: frame.listDepth }))
        continue
      }
      if (node.type === undefined) {
        state.typing.add('Any')
        finish('Any')
        continue
      }
      switch (node.type) {
        case 'string': finish(renderConstrainedScalar(node, 'str', state)); break
        case 'number': finish(renderConstrainedScalar(node, 'float', state)); break
        case 'integer': finish(renderConstrainedScalar(node, 'int', state)); break
        case 'boolean': finish(renderConstrainedScalar(node, 'bool', state)); break
        case 'null': finish('None'); break
        case 'array': {
          if (node.items === undefined) {
            state.typing.add('Any')
            finish('list[Any]')
            break
          }
          // Past MAX_LIST_NESTING another `list[` would push the annotation
          // beyond CPython's open-bracket limit and make the whole SDK block
          // unparseable, so the chain degrades here instead — an unusable
          // annotation either way, and this one is valid Python.
          if (frame.listDepth >= MAX_LIST_NESTING) {
            state.typing.add('Any')
            finish('Any')
            break
          }
          // An array of objects names its item type after the array field.
          frame.kind = 'array'
          frame.children = [{ schema: node.items, className: frame.className, listDepth: frame.listDepth + 1 }]
          break
        }
        case 'object': {
          // A missing `properties` is an empty property map, exactly as the
          // unified validator and the TS renderer read it — NOT an unknown
          // shape. The openness of the resulting empty object is decided below,
          // so a closed empty object still declares an empty TypedDict rather
          // than a permissive `dict[str, Any]`.
          const entries = Object.entries(node.properties ?? {})
          // An empty `className` marks the context-free `jsonSchemaToPy` entry:
          // there is no naming context to declare into, so degrade. This reads
          // the CALL's className, not `frame.className`: the marker belongs to
          // the whole walk, and frames propagate a derived name (a `oneOf`
          // branch of the context-free root gets the index-derived name `1` —
          // `childClassName` concatenates and caps, it does not go through
          // `camelCase`), so a per-frame read would declare classes the caller
          // has no way to receive, under a name that is not even a legal
          // identifier: `class 1(TypedDict):`. A field
          // name that is not a legal Python attribute is inexpressible as a
          // class-syntax `TypedDict` field, so such an object degrades whole.
          // A leading-double-underscore non-dunder field (`__token`) would be
          // NAME-MANGLED inside class syntax (`_ClassName__token`), describing a
          // different JSON key than the registered schema — degrade like any
          // other inexpressible field name.
          if (className === '' || !entries.every(([name]) => isBareIdentifier(name) && !RESERVED.has(name) && !(name.startsWith('__') && !name.endsWith('__')))) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          // An OPEN empty object is any dict; a CLOSED empty object declares an
          // empty TypedDict so "no keys accepted" survives into the SDK.
          if (entries.length === 0 && node.additionalProperties !== false) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          frame.kind = 'typeddict'
          frame.node = node
          frame.allocated = allocateClassName(frame.className, state)
          state.typing.add('TypedDict')
          frame.entries = entries
          // A field annotation is its own logical line, so nesting restarts —
          // at 1, reserving the bracket an optional field's `NotRequired[…]`
          // wraps around it. frame.allocated was assigned three statements up;
          // the ?? arm is for the type system only.
          /* v8 ignore next -- allocated is always set before children are built. */
          frame.children = entries.map(([field, child]) => ({ schema: child, className: childClassName(frame.allocated ?? '', camelCase(field)), listDepth: 1 }))
          break
        }
        /* v8 ignore next 4 -- assertSupportedJsonSchema narrowed this closed type union. */
        default: {
          state.typing.add('Any')
          finish('Any')
        }
      }
    }
    /* v8 ignore next -- every root frame produces one expression. */
    return result ?? 'Any'
  } catch {
    // An unsupported or malformed schema failed validation (before any
    // emission), or an unreachable internal invariant tripped. Either degrades
    // the node to `Any` rather than crashing prompt assembly — the Python
    // counterpart of the TS flavor's `unknown` fallback.
    state.typing.add('Any')
    return 'Any'
  }
}

/**
 * Map one JSON-Schema node to a context-free Python type expression from the
 * `typing` module. Handles every unified schema construct — `object` (degraded
 * to `dict[str, Any]`: naming a `TypedDict` requires the render context that
 * {@link renderToolsSdkPy} supplies), `const`/`enum` (→ `Literal[...]`),
 * `oneOf` (→ union), `string`/`number`/`integer`/`boolean`/`null`, `array`
 * (`items` → `list[T]`) — and returns `Any` for an unsupported or malformed
 * schema, matching the TS flavor's `unknown` fallback. Type annotations in the
 * emitted SDK are advisory: Python does not enforce them at runtime.
 * @param schema - the JSON-Schema node.
 * @returns the Python type text.
 */
export function jsonSchemaToPy(schema: unknown): string {
  // A throwaway state whose class collector never escapes: an object with
  // properties has nowhere to declare its TypedDict and degrades to
  // dict[str, Any]. renderToolsSdkPy drives the named-TypedDict path.
  return renderType(schema, '', { classes: [], usedClassNames: new Set(), nextClassCounter: new Map(), typing: new Set() })
}

/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async Python function (top-level \`await\` and \`return\` both work) — and \`description\`, a short summary of what the program does. At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. Only what you print and return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

The available tools:`

/**
 * Render the full `tools:sdk` prompt section under `runtime.language ===
 * 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
 * per tool argument or output object (and per nested object) and one awaitable
 * method per visible tool on a `Tools` protocol — typed args in, the tool's
 * canonical output value out — with a `tools: Tools` singleton the model calls
 * into. The `typing` import line lists exactly the symbols the render used.
 * Deterministic — tools are emitted in lexicographic name order, and class
 * declarations precede the protocol in that same order (nested classes before
 * the parent that references them), so an unchanged tool set produces
 * byte-identical text across assemblies. The sort is not a total order on
 * byte-equal names, so two schemas sharing a name would render in argument
 * order; the caller's visible-capability map is keyed by name, so the input
 * never carries a duplicate.
 * @param schemas - the tool schemas plus canonical output schemas to declare
 *   (the caller excludes `run_code` itself).
 * @returns the complete section text.
 */
export function renderToolsSdkPy(schemas: ToolSdkSchema[]): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const state: RenderState = { classes: [], usedClassNames: new Set(), nextClassCounter: new Map(), typing: new Set(['Protocol']) }
  // ONE ordered member stream, matching the documented lexicographic contract
  // and the TypeScript flavor (which quotes exotic keys in place rather than
  // partitioning them out). Interleaving is free here: a comment line between
  // two `async def` lines is not a statement, so it changes nothing about how
  // the class body parses.
  const members: string[] = []
  let statements = 0
  for (const schema of sorted) {
    const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state)
    const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state)
    if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith('_')) {
      // A docstring only documents its method when it is the FIRST statement
      // of that method's body. Emitted before the `async def` it would instead
      // become the `Tools` class docstring (for the first tool) or a dead
      // expression (for every later one), leaving every method undocumented —
      // and under `mode: 'ptc'` this SDK is the model's only description of
      // what a tool does. A docstring is a complete body, so the `...` stub is
      // only for the description-less case.
      const doc = docLines(schema.description, 2)
      members.push(doc.length > 0
        ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:`
        : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`)
      members.push(...doc)
      statements += 1
    } else {
      // Not reachable as ``tools.name`` — the model reaches it via
      // ``tools[name]``. Exotic names and hard keywords are not legal
      // attributes at all; an underscore-leading name (``_foo``) IS a legal
      // attribute and is routed here anyway, because the forms that break
      // split three ways — a non-dunder ``__token`` name-mangles at the CALL
      // site, a dunder that exists on ``object``/``type`` (``__class__``,
      // ``__doc__``) resolves before ``__getattr__`` ever runs, and implicit
      // special-method lookup skips the hook entirely — and one rule over the
      // whole family costs nothing while a per-form rule would have to
      // enumerate them (see {@link RESERVED}). The stub lists it as a subscript comment
      // (referencing the named TypedDicts too) so a reader sees what is
      // accessible; runtime resolution goes through the proxy's __getitem__.
      members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`)
      const description = describe(schema)
      if (description !== undefined) members.push(`${pad(1)}#   ${description}`)
    }
  }
  // Subscript entries are COMMENTS, not statements: a class body of only
  // comments fails to parse, so `pass` is required whenever no method was
  // emitted — including the subscript-only tool set.
  const bodyLines = statements > 0 ? members : [`${pad(1)}pass`, ...members]
  const body = bodyLines.join('\n')
  const imports = TYPING_ORDER.filter(symbol => state.typing.has(symbol))
  const classBlock = state.classes.length > 0 ? `${state.classes.join('\n\n')}\n\n` : ''
  const errorDeclaration = 'class ToolCallError(Exception):\n    toolName: str'
  const declaration = `from typing import ${imports.join(', ')}\n\n${errorDeclaration}\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`
  return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${declaration}\n\`\`\``
}
