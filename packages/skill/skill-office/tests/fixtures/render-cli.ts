/** Record real CLI operations and the appearance of rendered pixels. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Install a CLI wrapper in a caller-owned test directory.
 * @param cwd - Private fixture directory owned and removed by the calling test.
 * @param python - Bundled Python executable used to inspect preview pixels.
 * @param blank - Replace successful render images with fully transparent pixels.
 * @param calls - Operation-log path in an existing writable directory; defaults beside the wrapper.
 * @returns Path to the wrapper and its operation log.
 */
export async function renderCliFixture(
  cwd: string, python: string, blank: boolean, calls = join(cwd, '.fixture', 'calls.jsonl'),
): Promise<{ cli: string; calls: string }> {
  const cli = join(cwd, '.fixture', 'cli.js')
  const kit = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/cli'))
  const inspectPixels = [
    'from pathlib import Path',
    'from PIL import Image',
    'import sys',
    "paths = list(Path(sys.argv[1]).rglob('*.png'))",
    'assert paths',
    'all_blank = True',
    'for path in paths:',
    '    with Image.open(path) as image:',
    '        size = image.size',
    "    if sys.argv[2] == 'true':",
    "        Image.new('RGBA', size, (0, 0, 0, 0)).save(path)",
    '    with Image.open(path) as image:',
    "        rgba = image.convert('RGBA')",
    "        composite = Image.new('RGBA', rgba.size, 'white')",
    '        composite.alpha_composite(rgba)',
    "        all_blank &= all(low == high for low, high in composite.convert('RGB').getextrema())",
    'print(str(all_blank).lower())',
  ].join('\n')
  await mkdir(dirname(cli))
  await writeFile(cli, `
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [${JSON.stringify(kit)}, ...args], { encoding: 'utf8' });
let pixelsBlank = null;
if (result.status === 0 && args[0] === 'render') {
  const pixels = spawnSync(${JSON.stringify(python)}, ['-c', ${JSON.stringify(inspectPixels)}, args[args.indexOf('--output-dir') + 1], String(${blank})], { encoding: 'utf8' });
  if (pixels.status !== 0) throw new Error(pixels.stderr);
  pixelsBlank = pixels.stdout.trim() === 'true';
}
if (result.status === 0 && args[0] === 'capabilities') {
  const capabilities = JSON.parse(result.stdout);
  capabilities.runtime.cliPath = __filename;
  result.stdout = JSON.stringify(capabilities);
}
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, status: result.status, pixelsBlank }) + '\\n');
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
`)
  return { cli, calls }
}
