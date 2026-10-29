/** Typed methods shared by the host and its co-shipped Node execution process, and validation of untrusted program results. */
import type { PtcProgramFormat, PtcJsonValue, PtcRunFailure } from '@deepseek-ai/dsh-ptc-runtime'
import { decodePtcJsonWire, type PtcJsonWire } from './json-wire.ts'

/** Inputs for one program; host functions remain in the parent process. */
export interface ProgramBootData {
  /** Type-stripped JavaScript source. */
  code: string
  /** Evaluation syntax; omitted uses the installed bootstrap's default. */
  programFormat?: PtcProgramFormat
  /** Whether the host will reuse this process after the evaluation. */
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
  error?: { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string }
}

/** Host operations for the current evaluation; one pipe delivers its messages before its result. */
export interface HostMethods {
  /** Announce that the process can accept its first evaluation. */
  ready(): void
  /**
   * Invoke a binding under its originating host execution context.
   * @param global - Namespace global.
   * @param name - Function name within the namespace.
   * @param args - Flat lossless JSON arguments.
   * @returns Flat lossless JSON result; binding failures reject the call.
   */
  invoke(global: string, name: string, args: PtcJsonWire): Promise<PtcJsonWire>
  /**
   * Admit captured output before completion or interruption.
   * @param text - Captured text.
   */
  log(text: string): void
  /** Report exhausted program-side output accounting. */
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
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Decode a remote run result without trusting model-written control traffic.
 * @param result - Untrusted result returned by the program process.
 * @returns Decoded completion or failure; malformed envelopes throw a protocol error.
 */
export function readProgramResult(result: unknown): { value?: PtcJsonValue; error?: PtcRunFailure } {
  if (!record(result)) throw new Error('invalid program result')
  if (result.error !== undefined) {
    const error = result.error
    if (!record(error) || typeof error.message !== 'string'
      || (error.kind !== 'exception' && error.kind !== 'invalid-output' && error.kind !== 'output-limit')) {
      throw new Error('invalid terminal error')
    }
    return { error: { kind: error.kind, message: error.message } }
  }
  if (result.value === undefined) return {}
  const value = decodePtcJsonWire(result.value)
  return value === undefined ? { error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } } : { value }
}
