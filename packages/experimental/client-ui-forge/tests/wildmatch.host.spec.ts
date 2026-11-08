/** `.gitattributes` patterns: each pattern applies to the same paths as `git check-attr` applies it to. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attributesOf } from '../src/layers.ts'
import { git, scratch } from './harness.ts'

/** Patterns whose meaning differs between Git's wildmatch and shell or glob libraries, or that Git refuses. */
const PATTERNS = [
  'src/(group)/**', 'foo.{js,ts}', '*.ts', '/root.ts', 'src/*.ts', '**/fixtures/*.json', 'a/**/b.txt', 'docs/**', 'a**b.txt',
  'src/**x/*.ts', '***/deep.txt', '?.md', '[abc].txt', '[!abc].txt', '[^abc].txt', '[a-c]x.txt', '[z-a].txt', '[!z-a].txt',
  '[]].txt', '[]-a]y.txt', '[a-]x.txt', '[-a]w.txt', '[a-c-e]v.txt', '[\\]]u.txt', '[[:digit:]].txt', '[[:alpha:][:digit:]]z.txt',
  '[[:digit:]-z]t.txt', '[[:]x.txt', '[[:foo:]].txt', '[[:digit:]', '[ab', '\\*.txt', '\\[x].txt', 'end\\', 'a+b.txt', 'c$.txt',
  'x|y.txt', '\\!bang.txt', '!neg.txt', 'src/[[:upper:]]*.ts', 'src/[!a]*.ts', '[[:space:]]s.txt', '[[:punct:]]p.txt',
  '[a-\\c]r.txt', 'x[[:digit', 'y[\\', 'q[a-\\',
]

const PATHS = [
  'src/(group)/a.ts', 'src/group/a.ts', 'foo.{js,ts}', 'foo.js', 'a.ts', 'x/y/a.ts', 'root.ts', 'x/root.ts', 'src/a.ts', 'src/x/a.ts',
  'fixtures/a.json', 'x/fixtures/a.json', 'x/fixtures/y/a.json', 'a/b.txt', 'a/x/y/b.txt', 'docs/a/b.txt', 'docs', 'aXb.txt', 'aX/b.txt',
  'src/abx/a.ts', 'src/a/x/a.ts', 'deep.txt', 'x/y/deep.txt', 'q.md', 'qq.md', 'a.txt', 'd.txt', 'ax.txt', 'dx.txt', ']y.txt', '^y.txt',
  'ay.txt', 'by.txt', ']u.txt', 'ex.txt', '-x.txt', '-w.txt', 'aw.txt', 'av.txt', '-v.txt', 'dv.txt', 'ev.txt', '].txt', '5.txt',
  'z.txt', '5z.txt', 'zz.txt', '5t.txt', '-t.txt', 'zt.txt', '[x.txt', ':x.txt', '[[:digit:]', '[ab', 'ab', '*.txt', 'x.txt',
  '[x].txt', 'end', 'a+b.txt', 'aab.txt', 'c$.txt', 'x|y.txt', 'x.txt', '!bang.txt', 'neg.txt', '!neg.txt', 'src/Ab.ts', 'src/ab.ts',
  'src/bb.ts', ' s.txt', 'ss.txt', '.p.txt', 'pp.txt', 'x/.p.txt', 'br.txt', 'cr.txt', 'dr.txt', 'x[[:digit', 'y[', 'q[a-',
]

describe('attributesOf patterns', () => {
  let repo = ''
  let remove = async (): Promise<void> => {}

  beforeAll(async () => {
    ({ path: repo, remove } = await scratch('dsh-forge-wildmatch-'))
    await git(repo, 'init', '--quiet')
  })

  afterAll(async () => { await remove() })

  /** The paths `git check-attr` reports in the layer a one-line `.gitattributes` names. */
  async function gitMatches(pattern: string): Promise<string[]> {
    await writeFile(join(repo, '.gitattributes'), `${pattern} dsh-review-layer=test\n`)
    const output = await git(repo, '-c', `core.attributesFile=${join(repo, 'none')}`, '-c', 'core.ignoreCase=false',
      'check-attr', '-z', 'dsh-review-layer', '--', ...PATHS)
    const fields = output.split('\0')
    const matched: string[] = []
    for (let index = 0; index + 2 < fields.length; index += 3) {
      if (fields[index + 2] === 'test') matched.push(fields[index] ?? '')
    }
    return matched
  }

  it('applies each pattern to the paths git check-attr applies it to', async () => {
    for (const pattern of PATTERNS) {
      const read = attributesOf(`${pattern} dsh-review-layer=test\n`)
      const ours = PATHS.filter(path => read(path).layer === 'test')
      expect({ pattern, matched: ours }).toEqual({ pattern, matched: await gitMatches(pattern) })
    }
  })
})
