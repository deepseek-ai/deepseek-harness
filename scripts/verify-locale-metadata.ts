/** Check Japanese coverage of package metadata and plugin templates without loading plugins. */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { basename, posix, join, resolve } from 'node:path'
import { detailPath } from '../packages/util/plugin-detail/src/document.ts'
import { PRODUCT_PACKAGE_POLICY } from './product-package-policy.ts'
import { collectConfigCatalog } from './gen-config-catalog.ts'

/** Flatten metadata strings and reject values that cannot be translated. */
function strings(value: unknown, key = ''): Record<string, string> {
  if (typeof value === 'string' && value.trim() !== '') return { [key]: value }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${key}: expected non-empty text`)
  return Object.fromEntries(Object.entries(value).flatMap(([name, child]) => Object.entries(strings(child, key ? `${key}.${name}` : name))))
}

/**
 * Compare Japanese metadata with every field supplied by English or Chinese.
 * @param root - repository or fixture root.
 * @returns actionable missing-file, field, placeholder and resource diagnostics.
 */
export function localeMetadataProblems(root: string): string[] {
  const directories = new Set(globSync('packages/**/locale/**/*.json', {
    cwd: root, exclude: ['packages/**/node_modules/**', 'packages/**/lib/**', 'packages/**/tests/**'],
  }).map(file => file.replaceAll('\\', '/')).filter(file => ['en.json', 'zh.json', 'ja.json'].includes(basename(file))).map(file => posix.dirname(file)))
  for (const entry of collectConfigCatalog(root)) {
    const dir = entry.dir.replaceAll('\\', '/')
    if (PRODUCT_PACKAGE_POLICY[dir]?.category === 'test') continue
    if (entry.kind !== 'config' && entry.kind !== 'no-config') continue
    const directory = `${dir}/locale`
    directories.add(directory)
  }
  const problems: string[] = []
  if (directories.size === 0) return ['no package locale metadata found']
  for (const directory of [...directories].sort()) {
    try {
      const read = (language: string): Record<string, string> => {
        const file = join(root, directory, `${language}.json`)
        const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
        const dictionary = strings(value)
        const detail = detailPath(dictionary['meta.detail'], `${directory}/${language}.json: meta.detail`)
        const packageDir = directory.slice(0, directory.lastIndexOf('/locale'))
        if (detail !== undefined && !existsSync(resolve(root, packageDir, detail))) {
          throw new Error(`missing detail resource ${detail}`)
        }
        return dictionary
      }
      const en = read('en')
      const zh = existsSync(join(root, directory, 'zh.json')) ? read('zh') : {}
      const description = en['meta.description']
      if (description !== undefined && !/[.!?]$/u.test(description)) problems.push(`${directory}/en.json: meta.description must end with sentence punctuation`)
      const ja = read('ja')
      const expected = { ...zh, ...en }
      for (const key of new Set([...Object.keys(expected), ...Object.keys(ja)])) {
        if (ja[key] === undefined) problems.push(`${directory}/ja.json: missing ${key}`)
        else if (expected[key] === undefined) problems.push(`${directory}/ja.json: unexpected ${key}`)
        else {
          const placeholders = (text: string): string => (text.match(/\{\w+\}/gu) ?? []).sort().join(',')
          if (placeholders(ja[key]) !== placeholders(expected[key])) problems.push(`${directory}/ja.json: ${key} changes placeholders`)
        }
      }
    } catch (error) {
      problems.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return problems
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const problems = localeMetadataProblems(resolve(import.meta.dirname, '..'))
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exitCode = 1
  else console.log('verify-locale-metadata: all package and template metadata has complete Japanese translations.')
}
