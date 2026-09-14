/** Build the independent POSIX flock oracle used by native behavior tests. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'linux' && process.platform !== 'darwin') {
  throw new Error('The flock oracle is a POSIX test fixture');
}
const variants = process.platform === 'linux' ? ['glibc', 'musl'] : [''];
for (const variant of variants) {
  const compiler = variant === 'musl' ? 'musl-gcc' : 'cc';
  const output = path.join(root, 'test/bin', variant, 'flock-oracle');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
  if (process.platform === 'darwin') args.push('-mmacosx-version-min=11.0');
  if (variant === 'musl') args.push('-static');
  const result = spawnSync(compiler, [...args, path.join(root, 'test/fixtures/flock-oracle.c'), '-o', output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${compiler} failed to build the flock oracle`);
  console.log(`Built test oracle ${path.relative(root, output)}`);
}
