/** Acquire only filesystem state; this fixture never loads a signer or opens a token. */
import { beginWindowsSigningAttempt } from '../../scripts/windows-signing-state.mjs'
try {
  beginWindowsSigningAttempt({ runDirectory: process.argv[2], stateDirectory: process.argv[3], target: 'fixture.exe' })
  process.stdout.write('acquired')
} catch { process.stdout.write('blocked'); process.exitCode = 1 }
