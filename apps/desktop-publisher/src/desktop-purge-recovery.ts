/** Resume a fixed-URL purge without repeating ambiguous submissions. */
import type { teo } from 'tencentcloud-sdk-nodejs-teo'
import type { DesktopPurgeConfig } from './desktop-purge-types.ts'

/** Non-secret evidence saved before submission and after every observation. */
export interface DesktopPurgeRecord {
  readonly zoneId: string
  readonly publicUrl: string
  readonly submittedAt: string
  readonly jobId?: string | undefined
  readonly status: 'pending' | 'processing' | 'success' | 'failed' | 'timeout' | 'canceled' | 'unknown'
  readonly observedAt?: string | undefined
  readonly diagnostic?: string | undefined
}

/** SDK requests used by the recovery owner. */
export type DesktopPurgeRecoveryClient = Pick<InstanceType<typeof teo.v20220901.Client>, 'CreatePurgeTask' | 'DescribePurgeTasks'>

/** Explicit bounded observation policy; writes are never automatically retried. */
export interface DesktopPurgeRecoveryOptions {
  readonly intervalMs: number
  readonly waitMs: number
  readonly allowResubmit: boolean
  readonly now: () => number
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly save: (record: DesktopPurgeRecord) => Promise<void>
}

/** A confirmed remote failure, distinct from an unconfirmed observation. */
export class DesktopPurgeExecutionError extends Error {
  constructor(readonly status: 'failed' | 'timeout' | 'canceled') {
    super(`website cache purge: ${status}; inspect the task before manually rerunning`)
  }
}

function failed(status: DesktopPurgeRecord['status']): status is 'failed' | 'timeout' | 'canceled' {
  return status === 'failed' || status === 'timeout' || status === 'canceled'
}

async function observe(record: DesktopPurgeRecord, client: DesktopPurgeRecoveryClient,
  now: number, config: DesktopPurgeConfig): Promise<DesktopPurgeRecord> {
  const observedAt = new Date(now).toISOString()
  const unknown = (diagnostic: string): DesktopPurgeRecord => ({ ...record, status: 'unknown', observedAt, diagnostic })
  const matches = []
  try {
    let offset = 0
    do {
      const response = await client.DescribePurgeTasks({
        ZoneId: record.zoneId, Limit: 1000, Offset: offset,
        ...(record.jobId ? { Filters: [{ Name: 'job-id', Values: [record.jobId] }] } : {
          StartTime: record.submittedAt,
          EndTime: new Date(Math.min(now, Date.parse(record.submittedAt) + 120_000)).toISOString(),
        }),
      })
      if (!Array.isArray(response.Tasks) || typeof response.TotalCount !== 'number') return unknown('invalid query response')
      for (const task of response.Tasks) {
        if (task.Target !== record.publicUrl || task.Type !== 'purge_url') continue
        if (record.jobId ? task.JobId !== record.jobId
          : !task.CreateTime || !Number.isFinite(Date.parse(task.CreateTime))
            || Date.parse(task.CreateTime) < Date.parse(record.submittedAt)
            || Date.parse(task.CreateTime) > Date.parse(record.submittedAt) + 120_000) continue
        matches.push(task)
      }
      offset += response.Tasks.length
      if (offset >= response.TotalCount) break
      if (response.Tasks.length === 0 || offset >= 10_000) return unknown('task history could not be fully inspected')
    } while (true)
  } catch (_error) { return unknown('task query failed; check EdgeOne history and DescribePurgeTasks permission') }
  if (matches.length === 0) return unknown(record.jobId
    ? 'accepted task not found in query history; execution result unconfirmed'
    : 'no matching submission found; purge may not have been submitted; inspect EdgeOne history before manual recovery')
  const task = matches[0]
  if (matches.length !== 1 || !task) return unknown('multiple matching submissions found; cannot identify this submission')
  if (!task.JobId || !/^[\w.-]{1,128}$/u.test(task.JobId)
    || task.JobId.includes(config.secretId) || task.JobId.includes(config.secretKey)) return unknown('query returned no usable task ID')
  const status = task.Status
  if (status !== 'processing' && status !== 'success' && status !== 'failed' && status !== 'timeout' && status !== 'canceled') {
    return unknown('query returned an unknown task status')
  }
  return { zoneId: record.zoneId, publicUrl: record.publicUrl, submittedAt: record.submittedAt,
    jobId: task.JobId, status, observedAt }
}

/**
 * Submit at most once, or reconcile an earlier submission, then observe bounded completion.
 * Unknown results receive one additional query and return unknown for warning-only Actions completion.
 * @param config Validated destination and credentials; credentials never enter records.
 * @param previous Durable record, or undefined for a new publication.
 * @param client SDK client with bounded requests and no submission retry policy.
 * @param options Clock, persistence, timing and explicit manual-resubmission authorization.
 * @returns Successful or unconfirmed result; confirmed failures throw after durable recording.
 */
export async function recoverDesktopPurge(config: DesktopPurgeConfig, previous: DesktopPurgeRecord | undefined,
  client: DesktopPurgeRecoveryClient, options: DesktopPurgeRecoveryOptions): Promise<DesktopPurgeRecord> {
  if (options.intervalMs <= 0 || options.waitMs < 0) throw new Error('website cache purge: invalid observation budget')
  if (previous && (previous.zoneId !== config.zoneId || previous.publicUrl !== config.publicUrl)) {
    throw new Error('website cache purge: saved destination differs from selected publication')
  }
  let record = previous
  let observedPrevious = false
  if (record) {
    record = await observe(record, client, options.now(), config)
    observedPrevious = true
    await options.save(record)
    if (record.status === 'success') return record
    if (failed(record.status)) {
      if (!options.allowResubmit) throw new DesktopPurgeExecutionError(record.status)
      record = undefined
      observedPrevious = false
    }
  }
  if (!record) {
    record = { zoneId: config.zoneId, publicUrl: config.publicUrl,
      submittedAt: new Date(Math.floor(options.now() / 1000) * 1000).toISOString(), status: 'pending' }
    await options.save(record)
    let response: Awaited<ReturnType<DesktopPurgeRecoveryClient['CreatePurgeTask']>> | undefined
    try { response = await client.CreatePurgeTask({ ZoneId: config.zoneId, Type: 'purge_url', Targets: [config.publicUrl] }) }
    catch (_error) { /* Submission may have reached EdgeOne; reconcile history without repeating the request. */ }
    const jobId = response?.JobId
    if (response?.FailedList?.length) {
      record = { ...record, status: 'failed' }
    } else if (typeof jobId === 'string' && /^[\w.-]{1,128}$/u.test(jobId)
      && !jobId.includes(config.secretId) && !jobId.includes(config.secretKey)) {
      record = { ...record, status: 'processing', jobId }
    } else {
      record = { ...record, status: 'unknown', diagnostic: 'submission acceptance unconfirmed; checking task history' }
    }
    await options.save(record)
    if (failed(record.status)) throw new DesktopPurgeExecutionError(record.status)
  }
  let current: DesktopPurgeRecord = record
  const deadline = options.now() + options.waitMs
  let extraQuery = false
  while (true) {
    const observed: DesktopPurgeRecord = observedPrevious ? current : await observe(current, client, options.now(), config)
    observedPrevious = false
    current = observed
    await options.save(current)
    if (current.status === 'success') return current
    if (failed(current.status)) throw new DesktopPurgeExecutionError(current.status)
    if (extraQuery) {
      current = { ...current, status: 'unknown', diagnostic: current.diagnostic ?? (options.now() >= deadline ? 'observation deadline exceeded' : 'task still processing after an additional query') }
      await options.save(current)
      return current
    }
    if (current.status === 'unknown' || options.now() >= deadline) extraQuery = true
    await options.sleep(options.intervalMs)
  }
}
