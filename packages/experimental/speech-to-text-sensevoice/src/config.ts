/** Deployment configuration for the managed local SenseVoice recognizer. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Local runtime, inference, and retention settings. */
export interface Config {
  /** Unique registration id; consumers select this exact id. */
  providerId: string
  /** Absolute directory for verified ONNX models. */
  dataRoot: string
  /** Existing directory containing the selected ONNX model and tokens.txt; omission downloads verified files. */
  modelDirectory?: string | undefined
  /** Existing Silero VAD ONNX file; omission downloads the verified model. */
  vadModelPath?: string | undefined
  /** Weight precision; INT8 minimizes first-use download and model storage. */
  precision: 'int8' | 'fp32'
  /** Explicit Hugging Face-compatible origin; bypasses automatic selection and public fallback. */
  modelOrigin?: string | undefined
  /** Hugging Face-compatible origins compared before downloading each missing asset. */
  modelOrigins: string[]
  /** Deadline for concurrent HEAD probes, including redirects to the actual asset. */
  modelProbeTimeoutMs: number
  /** CPU intra-operation thread count. */
  threads: number
  /** Maximum speech segment length passed to the recognizer. */
  segmentSeconds: number
  /** Silero speech probability threshold. */
  vadThreshold: number
  /** Minimum speech duration retained by VAD. */
  minSpeechSeconds: number
  /** Silence separating two speech segments. */
  minSilenceSeconds: number
  /** Maximum decoded WAV bytes accepted by the private worker. */
  maxAudioBytes: number
  /** Deadline for runtime preparation and cold model loading. */
  prepareTimeoutMs: number
  /** Deadline for one inference after the worker is ready. */
  inferenceTimeoutMs: number
  /** Idle period before stopping the worker; zero keeps it warm. */
  idleTimeoutMs: number
  /** Maximum accepted running and waiting transcriptions. */
  maxPending: number
  /** Managed process termination grace period. */
  graceMs: number
  /** Maximum retained worker diagnostic bytes. */
  maxLogBytes: number
  /** Maximum transcript response bytes. */
  maxResponseBytes: number
  /** Minimum interval between intermediate download progress notifications. */
  progressIntervalMs: number
}

/** Validate deployment-varying runtime choices at plugin activation. */
export const Config: z<Partial<Config>, Config> = z.object({
  providerId: z.string().min(1).default('sensevoice-local'),
  dataRoot: z.string().min(1).required(),
  modelDirectory: z.union([z.string().min(1), z.const(undefined)]),
  vadModelPath: z.union([z.string().min(1), z.const(undefined)]),
  precision: z.union(['int8', 'fp32']).default('int8'),
  modelOrigin: z.union([z.string().pattern(/^https?:\/\/[^/\s?#@]+\/?$/), z.const(undefined)]),
  modelOrigins: z.array(z.string().pattern(/^https?:\/\/[^/\s?#@]+\/?$/)).min(1)
    .default(['https://huggingface.co', 'https://hf-mirror.com']),
  modelProbeTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3000),
  threads: z.natural().min(1).default(2),
  segmentSeconds: z.number().min(1).max(120).default(30),
  vadThreshold: z.number().min(0).max(1).default(0.5),
  minSpeechSeconds: z.number().min(0).default(0.25),
  minSilenceSeconds: z.number().min(0.01).default(0.5),
  maxAudioBytes: z.natural().min(46).default(4 * 1024 * 1024),
  prepareTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3_600_000),
  inferenceTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  idleTimeoutMs: z.natural().max(MAX_TIMER_DELAY_MS).default(300_000),
  maxPending: z.natural().min(1).default(4),
  graceMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(1000),
  maxLogBytes: z.natural().min(1).default(64 * 1024),
  maxResponseBytes: z.natural().min(1).default(128 * 1024),
  progressIntervalMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(100),
})
