/** Typed methods shared by the host and its co-shipped Node execution process, and validation of untrusted program results. */
import type { PtcProgramFormat, PtcJsonValue, PtcRunFailure } from '@deepseek-ai/dsh-ptc-runtime'
import type { BrandedNumber } from '@deepseek-ai/dsh-brand'
import { decodePtcJsonWire, type PtcJsonWire } from './json-wire.ts'

/** Wire revision required before the host dispatches program code. */
export const PROGRAM_PROTOCOL_VERSION = 1

/** Process-local identity of one evaluation; never reused within that process. */
export type EvaluationId = BrandedNumber<'PtcEvaluationId'>

/**
 * Validate an evaluation identity received over the process channel.
 * @param value - Untrusted wire value.
 * @returns Whether it is a positive safe integer.
 */
export function isEvaluationId(value: unknown): value is EvaluationId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Inputs for one program; host functions remain in the parent process. */
export interface ProgramBootData {
  /** Type-stripped JavaScript source. */
  code: string
  /** Evaluation syntax; omitted uses the installed bootstrap's default. */
  programFormat?: PtcProgramFormat
  /** Whether unfinished calls must reject before this environment is reused. */
  retainsState: boolean
  /** Globals and callable names injected into the program. */
  namespaces: {
    global: string
    names: string[]
    errorClass?: { name: string; memberNameProperty: string }
  }[]
  /** Combined serialized log and completion budget. */
  maxOutputBytes: number
}

/** Program completion; logs are delivered separately before this result. */
export interface ProgramResult {
  value?: PtcJsonWire
  error?: { kind: 'exception' | 'invalid-output' | 'output-limit' | 'abort'; message: string }
}

/** Completion identified independently of the RPC request that carries it. */
export interface EvaluationResult extends ProgramResult {
  evaluationId: EvaluationId
}

/** Program-facing invocation after the child has checked evaluation ownership. */
export interface BindingMethods {
  /**
   * Call one current binding.
   * @param global - Namespace global.
   * @param name - Function within that namespace.
   * @param args - Flat lossless JSON arguments.
   * @returns Flat lossless JSON result; active binding failures reject.
   */
  invoke(global: string, name: string, args: PtcJsonWire): Promise<PtcJsonWire>
}

/** Host operations for the current evaluation; one pipe delivers its messages before its result. */
export interface HostMethods {
  /**
   * Announce readiness before accepting an evaluation.
   * @param version - Bootstrap wire revision, checked against the host.
   */
  ready(version: number): void
  /**
   * Invoke a binding under its originating host execution context.
   * @param evaluationId - Originating evaluation.
   * @param global - Namespace global.
   * @param name - Function name within the namespace.
   * @param args - Flat lossless JSON arguments.
   * @returns Flat lossless JSON, or null when revoked; only active binding failures reject.
   */
  invoke(evaluationId: EvaluationId, global: string, name: string, args: PtcJsonWire): Promise<PtcJsonWire | null>
  /**
   * Admit captured output before completion or interruption.
   * @param evaluationId - Originating evaluation.
   * @param text - Captured text.
   */
  log(evaluationId: EvaluationId, text: string): void
  /**
   * Report exhausted program-side output accounting.
   * @param evaluationId - Originating evaluation.
   */
  outputLimit(evaluationId: EvaluationId): void
}

/** Operations implemented by either the per-call child or retained REPL. */
export interface ProgramMethods {
  /**
   * Evaluate code with the supplied binding declarations and output budget.
   * @param evaluationId - Unique identity assigned by the host.
   * @param cwd - Execution-world working directory.
   * @param data - Program and injected declarations.
   * @returns Completion or a bounded program failure, after captured output is sent.
   */
  run(evaluationId: EvaluationId, cwd: string, data: ProgramBootData): Promise<EvaluationResult>
  /**
   * Revoke bindings and output when the program thread can process the request.
   * @param evaluationId - Evaluation to revoke; older completed identities are ignored.
   * @returns After the revoked evaluation settles.
   */
  revoke(evaluationId: EvaluationId): Promise<void>
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Decode a remote run result without trusting model-written control traffic.
 * @param result - Untrusted result returned by the program process.
 * @param evaluationId - Identity expected by the host.
 * @returns Decoded completion or failure; malformed envelopes throw a protocol error.
 */
export function readProgramResult(result: unknown, evaluationId: EvaluationId): { value?: PtcJsonValue; error?: PtcRunFailure } {
  if (!record(result) || result.evaluationId !== evaluationId) throw new Error('invalid program result')
  if (result.error !== undefined) {
    const error = result.error
    if (!record(error) || typeof error.message !== 'string'
      || (error.kind !== 'exception' && error.kind !== 'invalid-output' && error.kind !== 'output-limit' && error.kind !== 'abort')) {
      throw new Error('invalid terminal error')
    }
    return { error: { kind: error.kind, message: error.message } }
  }
  if (result.value === undefined) return {}
  const value = decodePtcJsonWire(result.value)
  return value === undefined ? { error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } } : { value }
}
