/** Generate the macOS helper icon from the existing Computer Use bundle artwork. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

async function main() {
  const root = dirname(fileURLToPath(import.meta.url))
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-cua-icon-'))
  try {
    const iconset = join(scratch, 'DSHComputerUse.iconset')
    await mkdir(iconset)
    const source = await readFile(join(root, '../../cua-bundle/icon.svg'))
    const background = Buffer.from('<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="32" height="32" rx="7" fill="#FFFFFF"/></svg>')
    for (const points of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = points * scale
        const foreground = await sharp(source, { density: pixels * 2 }).resize(pixels, pixels).png().toBuffer()
        await sharp(background, { density: pixels * 2 }).resize(pixels, pixels)
          .composite([{ input: foreground }]).png()
          .toFile(join(iconset, `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`))
      }
    }
    execFileSync('/usr/bin/iconutil', ['--convert', 'icns', '--output', join(root, 'DSHComputerUse.icns'), iconset], { stdio: 'inherit' })
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
