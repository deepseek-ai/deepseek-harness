/**
 * Memory retention of `glob` search metadata: paths split from a large ripgrep stdout string must
 * not keep that string alive once the Session holds only the metadata. The case forces full
 * garbage collection and checks that heap usage returns near its baseline.
 */

import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { globSearchMeta } from '../src/presentation.ts'
import type { SearchMeta } from '../src/presentation.ts'

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

const STDOUT_CHARS = 32 * 1024 * 1024

function fullGc(): void {
  collect()
  collect()
}

function metaFromLargeStdout(): SearchMeta {
  const line = `src/${'nested/'.repeat(20)}file.ts\n`
  const stdout = line.repeat(Math.ceil(STDOUT_CHARS / line.length))
  const paths = stdout.split('\n', 3)
  return globSearchMeta({ items: paths, truncated: true, seen: paths.length }, 1_000_000)
}

it('globSearchMeta drops the stdout string behind its paths', () => {
  fullGc()
  const before = process.memoryUsage().heapUsed
  const meta = metaFromLargeStdout()
  fullGc()
  expect(process.memoryUsage().heapUsed - before).toBeLessThan(STDOUT_CHARS / 4)
  expect(meta).toMatchObject({ shape: 'paths', paths: Array.from({ length: 3 }, () => `src/${'nested/'.repeat(20)}file.ts`) })
})
