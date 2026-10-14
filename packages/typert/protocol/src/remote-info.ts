/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */

import type { z } from 'zod'
import type {
  InvocationDescriptor,
  TypertClientRemote,
  TypertRemoteCodecSpec,
  TypertRemoteInfo,
  TypertRemoteInputOptions,
  TypertRemoteMethod,
  TypertRemoteParameterSpec,
  TypertRemoteSpec,
  TypertRemoteValue,
} from './types.ts'

type Method = TypertRemoteMethod<object, unknown> | TypertRemoteMethod<object, unknown, 'stream', unknown>
type Parameter = TypertRemoteParameterSpec & { readonly wire: string }
type Index = Pick<TypertRemoteInfo, 'descriptors' | 'methods'>

/**
 * Retain one generated definition per endpoint without constructing parsers or projections.
 * The class instance builds its shared descriptor/method index on first access;
 * input schemas and JSON Schema projections are cached only when requested.
 * @param spec - compiler-produced method facts and Zod factories.
 * @param zod - the generated artifact's Zod runtime for named-input parsers.
 * @returns a lazy, mountable info instance with no registration or transport effects.
 */
export function createTypertRemoteInfo(spec: TypertRemoteSpec, zod: typeof z): TypertRemoteInfo {
  return new RemoteInfo(spec, zod)
}

class RemoteInfo implements TypertRemoteInfo {
  private index?: Index

  constructor(private readonly spec: TypertRemoteSpec, private readonly zod: typeof z) {}

  get package(): string { return this.spec.package }
  get descriptors(): readonly InvocationDescriptor[] { return this.resolve().descriptors }
  get methods(): TypertRemoteInfo['methods'] { return this.resolve().methods }

  private resolve(): Index {
    if (this.index !== undefined) return this.index
    const zod = this.zod
    const descriptors: InvocationDescriptor[] = []
    const methods = Object.create(null) as Record<string, Method>
    for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
      const separator = endpoint.indexOf('/')
      const namespace = endpoint.slice(0, separator)
      const method = endpoint.slice(separator + 1)
      const parameters = definition.parameters.map(parameter => ({ ...parameter, wire: parameter.wire ?? parameter.name }))
      const descriptor = {
        ...definition,
        id: `${this.spec.package}#${endpoint}`,
        namespace,
        method,
        parameters,
        result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result),
      }
      if (definition.invocation.kind === 'direct') {
        const inputs: [NamedInput?, NamedInput?] = []
        const direct = Object.assign(descriptor, {
          input(options?: TypertRemoteInputOptions) {
            const strict = options?.strict === true
            return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod)
          },
          invoke(remote: TypertClientRemote, input: object, signal?: AbortSignal) {
            const named = input as Readonly<Record<string, unknown>>
            const values = parameters.map(parameter => named[parameter.wire])
            if (definition.cancellation !== undefined) values.push(signal)
            // Namespace access retains the Gateway's mount checks and scoped receiver policy.
            const receiver = Reflect.get(remote, namespace) as object
            const call = Reflect.get(receiver, method) as (...args: unknown[]) => ReturnType<Method['invoke']>
            return call.apply(receiver, values)
          },
        })
        // The generated namespace return type is selected by this same descriptor's mode.
        methods[endpoint] = direct as Method
      }
      descriptors.push(descriptor)
    }
    return this.index = { descriptors, methods }
  }
}

/**
 * Narrow a Registry descriptor to its generated direct-method capabilities.
 * @param descriptor - a live descriptor, including possible source fallback or Context-only receivers.
 * @returns whether generated named input and direct invocation are available.
 */
export function isTypertRemoteMethod(descriptor: InvocationDescriptor): descriptor is Method {
  return descriptor.invocation.kind === 'direct' && descriptor.result.mode === 'strict'
    && 'input' in descriptor && typeof descriptor.input === 'function'
    && 'invoke' in descriptor && typeof descriptor.invoke === 'function'
}

function optional(parameter: Parameter): boolean {
  return parameter.source === 'json' && parameter.acceptsUndefined === true
}

class NamedInput implements TypertRemoteValue<object> {
  private schema?: z.ZodType<object>
  private projection?: Pick<TypertRemoteValue, 'jsonSchema' | 'jsonSchemaError'>

  constructor(
    private readonly parameters: readonly Parameter[],
    private readonly strict: boolean,
    private readonly zod: typeof z,
  ) {}

  private codec(parameter: Parameter): TypertRemoteCodecSpec {
    return this.strict ? parameter.strictCodec : parameter.codec
  }

  readonly create = (): z.ZodType<object> => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
    const value = this.codec(parameter).create()
    return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()]
  })))

  get jsonSchema(): TypertRemoteValue['jsonSchema'] { return this.project().jsonSchema }
  get jsonSchemaError(): string | undefined { return this.project().jsonSchemaError }

  private project(): NonNullable<NamedInput['projection']> {
    if (this.projection !== undefined) return this.projection
    const unavailable = this.parameters.find(parameter => this.codec(parameter).jsonSchema === undefined)
    if (unavailable !== undefined) {
      return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` }
    }
    return this.projection = {
      jsonSchema: {
        type: 'object',
        properties: Object.fromEntries(this.parameters.map(parameter => [parameter.wire, {
          ...this.codec(parameter).jsonSchema,
          ...(parameter.description === undefined ? {} : { description: parameter.description }),
        }])),
        required: this.parameters.filter(parameter => !optional(parameter)).map(parameter => parameter.wire),
        additionalProperties: false,
      },
    }
  }
}

class ResultValue implements TypertRemoteCodecSpec {
  private projection?: { readonly value: TypertRemoteValue['jsonSchema'] }

  constructor(private readonly spec: TypertRemoteCodecSpec) {}

  get mode(): 'strict' { return this.spec.mode }
  get typeSymbol(): string { return this.spec.typeSymbol }
  get create(): TypertRemoteCodecSpec['create'] { return this.spec.create }
  get decode(): TypertRemoteCodecSpec['decode'] { return this.spec.decode }
  get encode(): TypertRemoteCodecSpec['encode'] { return this.spec.encode }
  get description(): string | undefined { return this.spec.description }
  get jsonSchemaError(): string | undefined { return this.spec.jsonSchemaError }
  get jsonSchema(): TypertRemoteValue['jsonSchema'] {
    if (this.projection === undefined) {
      const schema = this.spec.jsonSchema
      this.projection = { value: schema === undefined ? undefined : { ...schema, description: this.spec.description } }
    }
    return this.projection.value
  }
}
