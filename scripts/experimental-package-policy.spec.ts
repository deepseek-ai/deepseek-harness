/** Retained package names keep experimental isolation and persisted record namespaces. */

import { describe, expect, it } from 'vitest'
import {
  EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS,
  experimentalPackageRecordNamespace,
  hasExperimentalPackageReference,
  isExperimentalPackageName,
} from './experimental-package-policy.ts'

const names = Object.values(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS)

describe('experimental package identities', () => {
  it.each([...names, '@deepseek-ai/dsh-experimental-terminal-bundle'])('recognizes %s independently of installation layout', (name) => {
    expect(isExperimentalPackageName(name)).toBe(true)
    for (const reference of [name, `${name}/client`, `${name}@1.2.3`, `npm:${name}@1.2.3`, `workspace:${name}@*`,
      `\0virtual:${name}/client?raw`, `/node_modules/${name}/lib/index.js`, `C:\\node_modules\\${name}\\lib\\index.js`, `C:\\node_modules\\${name.replaceAll('/', '\\')}\\lib\\index.js`]) {
      expect(hasExperimentalPackageReference(reference), reference).toBe(true)
    }
  })

  it.each(names)('does not extend the retained-name exception %s to another package', (name) => {
    for (const reference of [`${name}-unrelated`, `other-${name}`, name.replace('@deepseek-ai/', '@other/')]) {
      expect(isExperimentalPackageName(reference)).toBe(false)
      expect(hasExperimentalPackageReference(reference)).toBe(false)
      expect(experimentalPackageRecordNamespace(reference)).toBeUndefined()
    }
  })

  it('keeps new experimental packages under their prefixed namespaces', () => {
    expect(experimentalPackageRecordNamespace('@deepseek-ai/dsh-experimental-bridge')).toBe('bridge')
    expect(hasExperimentalPackageReference('@deepseek-ai/dsh-core')).toBe(false)
  })

  it.each(Object.entries(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS))('keeps %s record names independent of the retained npm name', (directory, name) => {
    expect(experimentalPackageRecordNamespace(name)).toBe(directory.split('/').at(-1))
  })
})
