import { HarnessError } from '@deepseek-ai/dsh-error'
import { JOB_ERROR_CODES, JobError } from '@deepseek-ai/dsh-jobs'
import { describe, expect, it } from 'vitest'

describe('JobError', () => {
  it.each(JOB_ERROR_CODES)('is a HarnessError named JobError with code %s', (code) => {
    const cause = new Error('registry detail')
    const error = new JobError('job operation failed', code, { cause })

    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ name: 'JobError', code, message: 'job operation failed', cause })
  })
})
