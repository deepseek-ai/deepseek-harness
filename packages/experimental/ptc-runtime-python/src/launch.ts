/** Deliver trusted Python bootstrap assets without depending on sandbox-visible temporary files. */
import { readFileSync } from 'node:fs'

/** Small interpreter entry point; bootstrap sources arrive on stdin before model execution. */
export const PYTHON_BOOTSTRAP_LOADER = [
  'import json, sys, types',
  '_sources = json.load(sys.stdin.buffer)',
  '_protocol = types.ModuleType("protocol")',
  '_protocol.__file__ = "<dsh-ptc-protocol>"',
  'exec(compile(_sources["protocol"], _protocol.__file__, "exec"), _protocol.__dict__)',
  'sys.modules["protocol"] = _protocol',
  'exec(compile(_sources["bootstrap"], "<dsh-ptc-bootstrap>", "exec"), globals())',
].join('\n')

/**
 * Read shipped assets through the host filesystem, including packaged virtual files.
 * @returns Trusted sources encoded for the interpreter's stdin loader.
 */
export function bootstrapInput(): string {
  return JSON.stringify({
    protocol: readFileSync(new URL('../py/protocol.py', import.meta.url), 'utf8'),
    bootstrap: readFileSync(new URL('../py/bootstrap.py', import.meta.url), 'utf8'),
  })
}
