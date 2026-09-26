import { expect, it } from 'vitest'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { definitionComposition } from '../src/composition-inventory.ts'

it('reports evaluated and unresolved conditions with ancestor enablement', () => {
  const js = (code: string) => ({ __jsExpr: code })
  const read = definitionComposition([
    { name: 'enabled', id: 'enabled-id' },
    { name: 'off', disabled: true },
    { name: 'on', disabled: js('false') },
    { name: 'conditional', disabled: js('unknownVariable') },
    { name: 'group', group: true, disabled: js('unknownVariable'), config: [
      { name: 'child' }, { name: 'disabled-child', disabled: true },
    ] },
    { name: 'off-group', group: true, disabled: true, config: [{ name: 'buried' }] },
  ], expression => evaluate({}, expression))
  expect(read).toEqual({ rows: [
    { entryId: 'enabled-id', moduleName: 'enabled', enabled: true },
    { entryId: null, moduleName: 'off', enabled: false },
    { entryId: null, moduleName: 'on', enabled: true, condition: 'false' },
    { entryId: null, moduleName: 'conditional', enabled: 'conditional', condition: 'unknownVariable' },
    { entryId: null, moduleName: 'child', enabled: 'conditional' },
    { entryId: null, moduleName: 'disabled-child', enabled: false },
    { entryId: null, moduleName: 'buried', enabled: false },
  ] })
  expect(definitionComposition([{ group: true }], () => false)).toHaveProperty('broken')
})
