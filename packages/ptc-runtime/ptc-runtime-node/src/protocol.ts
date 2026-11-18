/** Typed methods shared by the host and its co-shipped Node execution process, and validation of untrusted program results. */
import type { PtcProgramFormat, PtcJsonValue, PtcRunFailure } from '@deepseek-ai/dsh-ptc-runtime'
import { decodePtcJsonWire, type PtcJsonWire } from './json-wire.ts'

/** Wire revision required before the host dispatches program code. */
export const PROGRAM_PROTOCOL_VERSION = 5

/** One binding's JSON value and optional host-authored inspection text. */
export interface BindingResult {
  /** Flat lossless JSON data returned to the program. */
  value: PtcJsonWire
  /** Direct inspection text for an unchanged object or array. */
  inspection?: string
}

/** Inputs for one program; host functions remain in the parent process. */
export interface ProgramBootData {
  /** Type-stripped JavaScript source. */
  code: string
  /** Environment initialization, supplied only until the Host accepts initialized(). */
  initialization?: string
  /** Evaluation syntax; omitted uses the installed bootstrap's default. */
  programFormat?: PtcProgramFormat
  /** Whether the host will reuse this process after the evaluation. */
  retainsState: boolean
  /** Await successful completion without serializing its value. */
  discardCompletion?: boolean
  /** Globals and callable names injected into the program. */
  namespaces: {
    global: string
    names: string[]
    errorClass?: { name: string; memberNameProperty: string }
  }[]
  /** Combined serialized output and completion or diagnostic budget; terminal data takes priority. */
  maxOutputBytes: number
}

/** Program completion; logs are delivered separately before this result. */
export interface ProgramResult {
  value?: PtcJsonWire
  outputTruncated?: boolean
  error?: { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string }
}

/** Host operations for the current evaluation; one pipe delivers its messages before its result. */
export interface HostMethods {
  /**
   * Announce readiness before accepting an evaluation.
   * @param version - Bootstrap wire revision, checked against the host.
   */
  ready(version: number): void
  /**
   * Accept successful environment initialization while the first run remains active.
   * The child awaits the RPC reply before starting user code; cancellation rejects.
   * @returns Host acceptance before user code may start.
   */
  initialized(): Promise<void>
  /**
   * Invoke a binding under its originating host execution context.
   * @param global - Namespace global.
   * @param name - Function name within the namespace.
   * @param args - Flat lossless JSON arguments.
   * @returns JSON data with optional inspection text; binding failures and cancellation reject.
   */
  invoke(global: string, name: string, args: PtcJsonWire): Promise<BindingResult>
  /**
   * Admit captured output before completion or interruption.
   * @param text - Captured text.
   */
  log(text: string): void
  /**
   * Emit one registered image at the current output position.
   * @param id - Image identity issued by this process’s host.
   */
  image(id: string): void
  /** Report discarded program output without ending the evaluation. */
  outputLimit(): void
}

/** Operations implemented by either the per-call child or retained REPL. */
export interface ProgramMethods {
  /**
   * Evaluate code with the supplied binding declarations and output budget.
   * @param cwd - Execution-world working directory.
   * @param data - Program and injected declarations.
   * @returns Completion or a bounded program failure, after captured output is sent.
   */
  run(cwd: string, data: ProgramBootData): Promise<ProgramResult>
  /** Notify the program thread to revoke bindings and output; run() still owns completion. */
  revoke(): void
  /** Discard subsequent captured output while allowing execution and binding calls to continue. */
  discardOutput(): void
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Decode a remote run result without trusting model-written control traffic.
 * @param result - Untrusted result returned by the program process.
 * @returns Decoded completion or failure; malformed envelopes throw a protocol error.
 */
export function readProgramResult(result: unknown): { value?: PtcJsonValue; error?: PtcRunFailure; outputTruncated?: boolean } {
  if (!record(result) || (result.outputTruncated !== undefined && typeof result.outputTruncated !== 'boolean')) throw new Error('invalid program result')
  const truncation = result.outputTruncated ? { outputTruncated: true } : {}
  if (result.error !== undefined) {
    const error = result.error
    if (!record(error) || typeof error.message !== 'string'
      || (error.kind !== 'exception' && error.kind !== 'invalid-output' && error.kind !== 'output-limit')) {
      throw new Error('invalid terminal error')
    }
    return { ...truncation, error: { kind: error.kind, message: error.message } }
  }
  if (result.value === undefined) return truncation
  const value = decodePtcJsonWire(result.value)
  return value === undefined ? { ...truncation, error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } } : { ...truncation, value }
}
