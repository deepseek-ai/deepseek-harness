/**
 * `renderConfigDump` behavior: the offline composition must equal what
 * `boot()` mounts (same parser, same patch algorithm), print `!!js`
 * expressions verbatim, separate source-file runs with comment lines while
 * staying one loadable YAML document, and report skipped patches through
 * `warn` instead of failing — mirroring the Loader's boot-time warning for a
 * shared overlay whose row exists only on another surface.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches, renderConfigDump } from '../src/index.ts'

const NAME = 'dsh-test-bin'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-config-dump-'))
  tempRoots.push(dir)
  return dir
}

function writeBase(dir: string): string {
  const base = join(dir, 'base.yml')
  writeFileSync(base, [
    '- id: shared',
    '  name: ./noop.mjs',
    '  config:',
    '    value: base',
    '    key: !!js process.env.DSH_DUMP_SPEC',
    '- id: untouched',
    '  name: ./noop.mjs',
    '',
  ].join('\n'))
  return base
}

describe('renderConfigDump', () => {
  it('composes overlay layers in order, prints !!js verbatim, and labels each section with its source and patches', () => {
    const dir = tmp()
    const base = writeBase(dir)
    const surface = join(dir, 'surface.yml')
    writeFileSync(surface, [
      '- id: shared',
      '  config:',
      '    value: surface',
      '    key: !!js process.env.DSH_DUMP_SPEC',
      '- insert:',
      '    - id: surface-extra',
      '      name: ./noop.mjs',
      '',
    ].join('\n'))
    const user = join(dir, 'user.yml')
    writeFileSync(user, [
      '- id: surface-extra',
      '  config:',
      '    value: user',
      '',
    ].join('\n'))

    const dump = renderConfigDump(NAME, base, [
      { label: 'surface.yml', patches: loadOverlayPatches(NAME, surface) },
      { label: 'user.yml', patches: loadOverlayPatches(NAME, user) },
    ], () => {})
    // Comments do not break loadability: the dump parses as one document
    // equal to what boot() would mount.
    const parsed = yaml.load(dump, { schema: entryListSchema }) as {
      id: string
      config?: Record<string, unknown>
    }[]
    expect(parsed).toEqual([
      {
        id: 'shared',
        name: './noop.mjs',
        config: { value: 'surface', key: { __jsExpr: 'process.env.DSH_DUMP_SPEC' } },
      },
      { id: 'untouched', name: './noop.mjs' },
      {
        id: 'surface-extra',
        name: pathToFileURL(join(dir, 'noop.mjs')).href,
        config: { value: 'user' },
      },
    ])
    // Unevaluated: the expression text round-trips as a !!js scalar.
    expect(dump).toContain('!!js process.env.DSH_DUMP_SPEC')
    // Source separators: origin file, plus every layer that changed the
    // row; an inserted row carries the inserting layer as its origin.
    expect(dump).toContain('# == base.yml, patched by surface.yml')
    expect(dump).toContain('# == base.yml\n- id: untouched')
    expect(dump).toContain('# == surface.yml, patched by user.yml\n- id: surface-extra')
    expect(dump.indexOf('# == base.yml, patched by surface.yml')).toBeLessThan(dump.indexOf('# == base.yml\n- id: untouched'))
  })

  it('groups contiguous rows with the same origin and patches under one separator', () => {
    const dir = tmp()
    const base = join(dir, 'base.yml')
    writeFileSync(base, [
      '- id: a',
      '  name: ./noop.mjs',
      '- id: b',
      '  name: ./noop.mjs',
      '',
    ].join('\n'))
    const dump = renderConfigDump(NAME, base, [], () => {})
    expect(dump.match(/# == base\.yml/g)).toHaveLength(1)
    expect(dump).toContain('# == base.yml\n- id: a')
  })

  it('composes all layers as one flattened patch list, exactly like boot()', () => {
    // boot() flattens every layer into ONE applyEntryPatches call, whose id
    // index sees inserted rows but NOT children introduced by a plain group
    // `config` replacement. A per-layer composition would rebuild the index
    // between layers and let the second layer patch that child — a tree the
    // real boot never mounts. Pin the single-call semantics: the child patch
    // is skipped (with the layer-labeled warning), matching boot.
    const dir = tmp()
    const base = join(dir, 'base.yml')
    writeFileSync(base, [
      '- id: g',
      '  name: ./group.mjs',
      '  group: true',
      '  config: []',
      '',
    ].join('\n'))
    const warnings: string[] = []
    const dump = renderConfigDump(NAME, base, [
      {
        label: 'a.yml',
        patches: [{ id: 'g', config: [{ id: 'child', name: './noop.mjs', config: { v: 1 } }] }],
      },
      { label: 'b.yml', patches: [{ id: 'child', config: { v: 2 } }] },
    ], line => void warnings.push(line))
    expect(warnings).toEqual([`${NAME}: [b.yml] patch: entry "child" not found`])
    const parsed = yaml.load(dump, { schema: entryListSchema }) as {
      config?: { config?: { v?: number } }[]
    }[]
    expect(parsed[0]?.config?.[0]?.config?.v).toBe(1)
    // The skipped layer did not change the row, so the comment does not list it.
    expect(dump).toContain('# == base.yml, patched by a.yml\n- id: g')
    expect(dump).not.toContain('b.yml\n- id: g')
  })

  it('reports a patch whose target row is absent through warn with its layer label and keeps composing', () => {
    const dir = tmp()
    const base = writeBase(dir)
    const overlay = join(dir, 'overlay.yml')
    writeFileSync(overlay, [
      '- id: only-on-another-surface',
      '  config:',
      '    value: ignored',
      '- id: shared',
      '  config:',
      '    value: patched',
      '',
    ].join('\n'))
    const warnings: string[] = []
    const dump = renderConfigDump(
      NAME, base,
      [{ label: 'overlay.yml', patches: loadOverlayPatches(NAME, overlay) }],
      line => void warnings.push(line),
    )
    expect(warnings).toEqual([`${NAME}: [overlay.yml] patch: entry "only-on-another-surface" not found`])
    const parsed = yaml.load(dump, { schema: entryListSchema }) as { config?: { value?: string } }[]
    expect(parsed[0]?.config?.value).toBe('patched')
  })

  it('defaults its warn sink to one stderr line per skipped patch', () => {
    const dir = tmp()
    const base = writeBase(dir)
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      renderConfigDump(NAME, base, [{ label: 'x.yml', patches: [{ id: 'absent', config: {} }] }])
      expect(write).toHaveBeenCalledWith(`${NAME}: [x.yml] patch: entry "absent" not found\n`)
    } finally {
      write.mockRestore()
    }
  })

  it('fails loud on a missing, unparsable, or non-array base config', () => {
    const dir = tmp()
    expect(() => renderConfigDump(NAME, join(dir, 'absent.yml'), [], () => {}))
      .toThrow(new RegExp(`^${NAME}: failed to read config `))
    const invalid = join(dir, 'invalid.yml')
    writeFileSync(invalid, 'invalid: [unclosed\n')
    expect(() => renderConfigDump(NAME, invalid, [], () => {}))
      .toThrow(new RegExp(`^${NAME}: failed to parse config `))
    const scalar = join(dir, 'scalar.yml')
    writeFileSync(scalar, 'id: not-a-list\n')
    expect(() => renderConfigDump(NAME, scalar, [], () => {}))
      .toThrow('must be a top-level YAML array of entries')
  })
})
