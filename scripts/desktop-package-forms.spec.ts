import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

it('presents common packaging fields in the same order with the same defaults', () => {
  const workflows = ['macos-package.yml', 'macos-intel-package.yml', 'windows-package.yml'].map(name =>
    yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows', name), 'utf8')) as {
      on: { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } }
    })
  const common = ['source_ref', 'preset', 'update_channel', 'version_mode', 'build_version', 'test_release_id', 'compression_level']
  const reference = workflows[0]!.on.workflow_dispatch.inputs
  for (const workflow of workflows) {
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs).slice(0, common.length)).toEqual(common)
    for (const field of common) {
      const { description: _description, ...settings } = inputs[field]!
      const { description: _referenceDescription, ...expected } = reference[field]!
      expect(settings).toEqual(expected)
      if (field !== 'compression_level') expect(inputs[field]).toEqual(reference[field])
    }
  }
})
