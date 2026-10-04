# Agent Note: Unified JSON-value schema DSL

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-20-unified-json-value-schema-dsl.zh.md)

## Problem

Tool parameters used a small author DSL while subagent/workflow structured output used a separate raw JSON Schema subset and validator. The two vocabularies disagreed about roots, scalar constraints, and validation, so a typed canonical tool-output contract would either duplicate both paths again or accept schemas that some projection could not enforce.

## Decision

`dsh-tools` owns one JSON-value schema vocabulary with two representations. `ValueSchemaSpec` is the author form for any JSON root; `ParameterSchemaSpec` is its implicit object-property-map form with per-property `required: true`. `JsonSchemaNode` is the raw wire form. Both support string, finite number, integer, boolean, null, array, object, type-correct scalar `enum`/`const`, and exact-one `oneOf`; `{ type: 'json' }` is author-only sugar for an annotation-only unconstrained raw node.

An explicit author object must declare `additionalProperties: true | false`. The implicit parameter root and raw JSON Schema preserve the standard open default. Schema records contain only own enumerable string keys, schema arrays are dense intrinsic arrays, and supported keywords are read as own properties; custom prototypes, inherited constraints, symbols, and JSON-invisible decorations therefore cannot make compilation, projection, and validation observe different declarations. Intrinsic plain Object and Array containers remain plain across JavaScript realms, while subclasses and forged constructor prototypes remain exotic.

`InferValue<S>` and `InferArgs<P>` derive TypeScript values from the same declarations that `valueSchemaSpecToJsonSchema()` and `parameterSchemaSpecToJsonSchema()` compile. Exact inference is bounded to 16 container levels and then uses `JsonValue`, preventing TypeScript's type-instantiation stack from becoming the authoring limit. `assertSupportedJsonSchema()` rejects unsupported or misplaced keywords, and `validateJsonSchemaValue()` enforces the accepted subset against the lossless `JsonValue` boundary: no `undefined`, negative zero, non-finite numbers, sparse arrays, cycles, exotic objects, functions, symbols, or other coercive values. Author compilation, raw-schema assertion, value validation, schema-to-TypeScript rendering, registry detachment, and dynamic Cordis cross-realm normalization and cloning use explicit work stacks, so runtime nesting is limited by available memory rather than the JavaScript call stack.

Object-rooting is a consumer rule rather than a vocabulary restriction. Subagent and workflow caller-defined structured outputs use `assertObjectJsonSchema()` and `ObjectJsonSchema`; tool outputs may use any root. Dynamic Cordis registrations rebuild realm-foreign schemas into host-owned JSON, preserve raw-wrapper openness, and require direct-DSL object openness before calling the same compiler. The dynamic boundary rejects JSON-invisible record keys and exotic schema arrays before normalization, so it cannot silently discard a constraint or consume custom iteration semantics.

## Alternatives considered

- **Keep separate parameter and structured-output schema systems:** rejected because every added output construct would require parallel inference, compilation, validation, and code-generation changes with no useful ownership boundary.
- **Use Schemastery for tool parameters:** rejected because Schemastery targets validation and transformation through Standard Schema rather than JSON Schema generation. It would add an adapter layer without producing the model-facing wire schema or the shared output vocabulary.
- **Adopt full JSON Schema or Ajv:** rejected because the harness must fail on every construct it cannot project into its generated SDK and validators; accepting a larger language would make enforcement and model guidance dishonest.
- **Make every object implicitly open or closed:** rejected because either choice hides a consequential author decision. Only the legacy-shaped implicit parameter root and external raw schema retain an intentional default.
- **Define `oneOf` as first-match:** rejected because branch ordering would change validation semantics and allow overlapping branches to hide ambiguous values.

## Consequences

- Parameter validation, output validation, schema-to-TypeScript generation, subagent/workflow guards, and dynamic registration share one enforced vocabulary.
- Output declarations can infer object, array, scalar, or null roots; subagent/workflow structured outputs remain object-rooted at their existing seams.
- Explicit object openness and type-correct literal constraints make malformed declarations fail during authoring or registration rather than during a later model call.
- Bounded type inference retains useful exact types for ordinary declarations and degrades unusually deep tails to `JsonValue`; runtime schema enforcement remains exact at every depth.
- Raw tools may still register broader JSON Schema directly, but unified code generation treats unsupported schemas as unknown instead of pretending to enforce them.
- Per-property `required: true` remains the tool-author contract, and type-level regression coverage pins required keys as non-optional after the original inference path exposed an optionality bug.
- Runtime and compile-time tests cover every root, exact-one overlap/no-match behavior, raw open defaults, explicit openness, lossy JSON values, inference, deep nesting across core and dynamic projections, JSON-invisible dynamic keys, and exotic schema arrays.
