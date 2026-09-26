/** Source checks for the changed-files and explicit-delivery layout. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), 'utf8')

describe('deliverables layout', () => {
  it('keeps the first file-section offset and removes the second', () => {
    expect(read('ChangedFiles.module.css')).toMatch(/\.card\s*\{[^}]*margin-top:\s*4px/s)
    const deliveries = read('Deliverables.module.css')
    expect(deliveries).toMatch(/\.root\s*\{[^}]*margin-top:\s*4px/s)
    expect(deliveries).toMatch(/\.root\[data-after-changes='true'\]\s*\{\s*margin-top:\s*0;\s*\}/)
    expect(deliveries).toMatch(/\.file\s*\{[^}]*height:\s*60px;[^}]*padding:\s*8px 10px/s)
    expect(deliveries).toMatch(/\.fileIcon\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*40px;[^}]*height:\s*40px/s)
    expect(deliveries).toMatch(/\.fileIcon\s*\{[^}]*border:\s*0\.5px solid var\(--dsw-alias-border-l1\)/s)
    expect(read('PresentedFileCard.tsx')).toMatch(/<FileTypeIcon path=\{file\.path\} size=\{20\} \/>/)
    expect(deliveries).toMatch(/\.fileName\s*\{[^}]*font-size:\s*13px;[^}]*line-height:\s*20px/s)
    expect(deliveries).toMatch(/\.description\s*\{[^}]*font-size:\s*10px;[^}]*line-height:\s*16px/s)
    expect(deliveries).toMatch(/\.presented\s*\{[^}]*gap:\s*10px/s)
  })

})
