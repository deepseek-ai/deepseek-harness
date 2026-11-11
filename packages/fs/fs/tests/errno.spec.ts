/** Errno classification into the shared filesystem codes. */
import { describe, expect, it } from 'vitest'
import { FsError, fsErrorFromErrno } from '@deepseek-ai/dsh-fs'

describe('fsErrorFromErrno', () => {
  const errno = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code })

  it.each([
    ['ENOENT', 'FS_NOT_FOUND', 'not found'],
    ['ENOTDIR', 'FS_NOT_FOUND', 'not found'],
    ['EACCES', 'FS_PERMISSION_DENIED', 'permission denied'],
    ['EPERM', 'FS_PERMISSION_DENIED', 'permission denied'],
    ['EISDIR', 'FS_NOT_REGULAR_FILE', 'not a regular file'],
    ['ELOOP', 'FS_IO_ERROR', 'ELOOP: injected'],
  ])('maps %s to %s with the Node error as cause', (code, fsCode, detail) => {
    const cause = errno(code)
    expect(fsErrorFromErrno('read', '~/a', cause)).toMatchObject({
      name: 'FsError', code: fsCode, message: `cannot read "~/a": ${detail}`, cause,
    })
  })

  it.each([
    new FsError('already typed', 'FS_TOO_LARGE'),
    new Error('defect'),
    Object.assign(new Error('numeric code'), { code: 1 }),
    'not an error',
  ])('returns typed failures and defects unchanged: %s', (value) => {
    expect(fsErrorFromErrno('read', 'a', value)).toBe(value)
  })
})
