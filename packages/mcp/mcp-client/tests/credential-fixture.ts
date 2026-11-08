/** In-memory credential references for template tests; record operations are unexpected. */

import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

/** Resolves references from {@link TestCredentials.values}; every other operation throws. */
export class TestCredentials extends CredentialProvider {
  values = new Map<string, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'fixture' })
  }

  describe(): Promise<CredentialInfo> { throw new Error('unexpected credential description') }
  set(): Promise<void> { throw new Error('unexpected credential write') }
  unset(): Promise<void> { throw new Error('unexpected credential removal') }
  readRecord(): Promise<CredentialRecord | undefined> { throw new Error('unexpected record read') }
  describeRecord(): Promise<CredentialRecordInfo> { throw new Error('unexpected record description') }
  listRecords(): Promise<readonly CredentialRecordEntry[]> { throw new Error('unexpected record listing') }
  modifyRecord(): Promise<CredentialRecord | undefined> { throw new Error('unexpected record write') }
  deleteRecord(): Promise<void> { throw new Error('unexpected record removal') }
}
