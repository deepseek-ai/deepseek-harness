/** Disposable localhost TLS material; clients must explicitly trust the generated certificate. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { generate } from 'selfsigned'

/** Materialized TLS fixture: the served certificate and key, plus the client's trust anchor. */
export interface TlsFixture {
  /** Certificate file for `tls.certFile`. */
  certFile: string
  /** Private key file for `tls.keyFile` (unencrypted PEM, mode 0600). */
  keyFile: string
  /** Certificate file a client trusts, or imports into a browser trust store. */
  caFile: string
  /** The certificate PEM, as written to {@link certFile} and {@link caFile}. */
  ca: string
}

const COMMON_NAME = 'localhost'

let generated: { cert: string; key: string } | undefined

/** One self-signed localhost certificate per process; RSA key generation is the only slow part. */
function tlsPems(): { cert: string; key: string } {
  generated ??= (() => {
    const { cert, private: key } = generate([{ name: 'commonName', value: COMMON_NAME }], {
      keySize: 2048,
      days: 30,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: COMMON_NAME },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' },
          ],
        },
      ],
    })
    return { cert, key }
  })()
  return generated
}

/**
 * Write the fixture into a directory, creating it when needed.
 * @param directory - output directory; the fixture's own file names are replaced.
 * @returns the written paths plus the PEM a client trusts.
 */
export async function materializeTlsFixture(directory: string): Promise<TlsFixture> {
  const pems = tlsPems()
  const root = resolve(directory)
  const fixture: TlsFixture = {
    certFile: join(root, 'tls-cert.pem'),
    keyFile: join(root, 'tls-key.pem'),
    caFile: join(root, 'tls-ca.pem'),
    ca: pems.cert,
  }
  await mkdir(root, { recursive: true })
  await Promise.all([
    writeFile(fixture.certFile, pems.cert),
    writeFile(fixture.caFile, pems.cert),
    writeFile(fixture.keyFile, pems.key, { mode: 0o600 }),
  ])
  return fixture
}
