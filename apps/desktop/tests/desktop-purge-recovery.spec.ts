import { describe, expect, it, vi } from 'vitest'
import { desktopPublicationFailure } from '../scripts/desktop-publication-failure.ts'
import { recoverDesktopPurge, type DesktopPurgeRecord, type DesktopPurgeRecoveryOptions } from '../scripts/desktop-purge-recovery.ts'

const config = { zoneId: 'zone-test', publicUrl: 'https://download.deepseek.com/desktop/test.dmg', secretId: 'secret-id', secretKey: 'secret-key' }
const submittedAt = '2026-10-30T00:00:00.000Z'
function fixture() {
  let clock = Date.parse(submittedAt)
  const records: DesktopPurgeRecord[] = []
  const options: DesktopPurgeRecoveryOptions = {
    intervalMs: 10, waitMs: 20, allowResubmit: false, now: () => clock,
    sleep: async (ms) => { clock += ms }, save: async (record) => { records.push(record) },
  }
  const task = (status: string, jobId = 'job-1') => ({ TotalCount: 1, Tasks: [{ JobId: jobId, Status: status,
    Target: config.publicUrl, Type: 'purge_url', CreateTime: submittedAt }] })
  const client = { CreatePurgeTask: vi.fn(async () => ({ JobId: 'job-1' })), DescribePurgeTasks: vi.fn(async () => task('success')) }
  return { options, records, task, client }
}

describe('website purge recovery', () => {
  it('saves intent before submitting once and confirms completion', async () => {
    const f = fixture()
    f.client.CreatePurgeTask.mockImplementation(async () => {
      expect(f.records.at(-1)?.status).toBe('pending')
      return { JobId: 'job-1' }
    })
    expect((await recoverDesktopPurge(config, undefined, f.client, f.options)).status).toBe('success')
    expect(f.client.CreatePurgeTask).toHaveBeenCalledOnce()
    expect(f.records.map(r => r.status)).toEqual(['pending', 'processing', 'success'])
  })

  it('queries an existing successful task without submitting again', async () => {
    const f = fixture()
    const previous: DesktopPurgeRecord = { ...config, submittedAt, jobId: 'job-1', status: 'unknown' }
    expect((await recoverDesktopPurge(config, previous, f.client, f.options)).status).toBe('success')
    expect(f.client.CreatePurgeTask).not.toHaveBeenCalled()
  })

  it('reconciles a lost submission response using exact history', async () => {
    const f = fixture()
    f.client.CreatePurgeTask.mockRejectedValue(new Error(config.secretKey))
    expect((await recoverDesktopPurge(config, undefined, f.client, f.options)).jobId).toBe('job-1')
    expect(f.client.CreatePurgeTask).toHaveBeenCalledOnce()
    expect(f.client.DescribePurgeTasks.mock.calls[0]).toBeDefined()
    expect(JSON.stringify(f.records)).not.toContain(config.secretKey)
  })

  it('queries once more after uncertainty and preserves an unknown result', async () => {
    const f = fixture()
    f.client.DescribePurgeTasks.mockRejectedValue(new Error(config.secretKey))
    const result = await recoverDesktopPurge(config, undefined, f.client, f.options)
    expect(result.status).toBe('unknown')
    expect(f.client.DescribePurgeTasks).toHaveBeenCalledTimes(2)
    expect(f.client.CreatePurgeTask).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.records)).not.toContain(config.secretKey)
  })

  it('does not claim deadline expiry when the extra query resumes processing', async () => {
    const f = fixture()
    f.client.DescribePurgeTasks.mockRejectedValueOnce(new Error('transient')).mockResolvedValue(f.task('processing'))
    const result = await recoverDesktopPurge(config, undefined, f.client, f.options)
    expect(result.diagnostic).toBe('task still processing after an additional query')
    expect(result.status).toBe('unknown')
    expect(f.client.DescribePurgeTasks).toHaveBeenCalledTimes(2)
    expect(f.options.now()).toBeLessThan(Date.parse(submittedAt) + f.options.waitMs)
  })

  it('bounds processing observations and makes one final query', async () => {
    const f = fixture()
    f.client.DescribePurgeTasks.mockResolvedValue(f.task('processing'))
    expect((await recoverDesktopPurge(config, undefined, f.client, f.options)).status).toBe('unknown')
    expect(f.client.DescribePurgeTasks).toHaveBeenCalledTimes(4)
  })

  it.each(['failed', 'timeout', 'canceled'])('fails for confirmed %s without retrying submission', async (status) => {
    const f = fixture()
    f.client.DescribePurgeTasks.mockResolvedValue(f.task(status))
    await expect(recoverDesktopPurge(config, undefined, f.client, f.options)).rejects.toThrow(status)
    expect(f.client.CreatePurgeTask).toHaveBeenCalledOnce()
    expect(f.records.at(-1)?.status).toBe(status)
    const saved = f.records.at(-1)!
    await recoverDesktopPurge(config, saved, f.client, f.options).catch((error: unknown) => {
      expect(desktopPublicationFailure(error, 'purge')).toMatchObject({ code: `purge-${status}` })
    })
  })

  it('allows one replacement only after a manual rerun confirms previous failure', async () => {
    const f = fixture()
    f.client.DescribePurgeTasks.mockResolvedValueOnce(f.task('failed')).mockResolvedValue(f.task('success'))
    const previous: DesktopPurgeRecord = { zoneId: config.zoneId, publicUrl: config.publicUrl, submittedAt, jobId: 'old-job', status: 'failed' }
    f.client.DescribePurgeTasks.mockReset().mockResolvedValueOnce(f.task('failed', 'old-job')).mockResolvedValue(f.task('success'))
    expect((await recoverDesktopPurge(config, previous, f.client, { ...f.options, allowResubmit: true })).status).toBe('success')
    expect(f.client.CreatePurgeTask).toHaveBeenCalledOnce()
  })

  it('does not submit when intent persistence fails', async () => {
    const f = fixture()
    await expect(recoverDesktopPurge(config, undefined, f.client, { ...f.options,
      save: async () => { throw new Error('disk full') },
    })).rejects.toThrow('disk full')
    expect(f.client.CreatePurgeTask).not.toHaveBeenCalled()
  })

  it('reports a possibly absent submission without resubmitting it', async () => {
    const f = fixture()
    f.client.CreatePurgeTask.mockRejectedValue(new Error('lost response'))
    f.client.DescribePurgeTasks.mockResolvedValue({ TotalCount: 0, Tasks: [] })
    const result = await recoverDesktopPurge(config, undefined, f.client, f.options)
    expect(result.status).toBe('unknown')
    expect(result.diagnostic).toContain('may not have been submitted')
    expect(result.jobId).toBeUndefined()
    expect(f.client.CreatePurgeTask).toHaveBeenCalledOnce()
    expect(f.client.DescribePurgeTasks).toHaveBeenCalledTimes(2)
  })

  it('does not mistake multiple matching tasks for confirmed completion', async () => {
    const f = fixture()
    f.client.CreatePurgeTask.mockRejectedValue(new Error('lost response'))
    f.client.DescribePurgeTasks.mockResolvedValue({ TotalCount: 2, Tasks: [...f.task('success').Tasks, ...f.task('success', 'job-2').Tasks] })
    expect((await recoverDesktopPurge(config, undefined, f.client, f.options)).status).toBe('unknown')
    expect(f.client.CreatePurgeTask).toHaveBeenCalledOnce()
  })
})
