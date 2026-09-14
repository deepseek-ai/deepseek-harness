/** Load the private callback API to test native completion independently of its Promise wrapper. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** @returns The built addon's private callback binding for this host. */
export function loadFlockBinding() {
  const libc = process.platform === 'linux'
    ? `${process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'}/`
    : '';
  const binary = new URL(`../../packages/${process.platform}-${process.arch}/bin/${libc}system.node`, import.meta.url);
  return createRequire(import.meta.url)(fileURLToPath(binary));
}
