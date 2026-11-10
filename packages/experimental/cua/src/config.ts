/** Schemastery fields for platform-specific native CUA configuration. */
import Schema from '@deepseek-ai/schemastery'
import NodePtcRuntime, { type Config as NodeRuntimeConfig } from '@deepseek-ai/dsh-ptc-runtime-node'
import { RunCodeConfig } from '@deepseek-ai/dsh-tool-executor-ptc/run-code'

/** Resource bounds for the dedicated CUA program runtime and its nested tool calls. */
export interface CuaStandaloneRunCodeConfig {
  /** Node limits and launch settings; setting executionMode or scriptPersistence is rejected. */
  runtime: Omit<NodeRuntimeConfig, 'executionMode' | 'scriptPersistence'>
  /** Timeout-scaled tool-call allowance and maximum concurrent subcalls. */
  executor: RunCodeConfig
}

const runtimeFields: Record<string, Schema> = {
  ...NodePtcRuntime.Config.dict,
  executionMode: Schema.never().hidden(),
  scriptPersistence: Schema.never().hidden(),
}

/** Validate CUA program limits with the shared Node and executor defaults. */
export const CuaStandaloneRunCodeConfig: Schema<Partial<CuaStandaloneRunCodeConfig>, CuaStandaloneRunCodeConfig> = Schema.object({
  runtime: Schema.object(runtimeFields).default({}),
  executor: RunCodeConfig.default({}),
})

/** Shared configuration fields extended by native platform providers. */
export const CuaConfigFields = {
  requireSystemPointerApproval: Schema.boolean().default(true),
  agentPreset: Schema.union([Schema.string().min(1), Schema.const(false)]).default('ptc'),
  standaloneRunCode: CuaStandaloneRunCodeConfig.default({}),
  allowedApps: Schema.array(Schema.object({
    id: Schema.string().pattern(/^[a-f0-9]{64}$/).required(),
    name: Schema.string().required(), executablePath: Schema.string().min(1),
  })).default([]),
  helperPath: Schema.string(),
  buildTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(300_000),
  timeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(30_000),
  connectTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5000),
  screenshotTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5000),
  axTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3000),
  maxAppMatches: Schema.number().step(1).min(1).max(1000).default(20),
  maxClipboardBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
  pasteReadTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(1000),
  maxRequestBytes: Schema.number().step(1).min(1024).default(1024 * 1024),
  dragDurationMs: Schema.number().step(1).min(1).max(5000).default(400),
  maxClickHoldMs: Schema.number().step(1).min(0).max(2 ** 31 - 1).default(5000),
  dragSteps: Schema.number().step(1).min(1).max(240).default(20),
  maxResponseBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
  textEventIntervalMs: Schema.number().min(0).max(1000).default(0.25),
  graceMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3000),
  maxElements: Schema.number().step(1).min(1).max(10000).default(2000),
  maxDepth: Schema.number().step(1).min(1).max(100).default(25),
}
