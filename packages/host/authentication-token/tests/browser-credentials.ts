/** Mutable credential records used by the token implementation tests. */
import { CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished } from 'vitest'

export class RecordCredentials extends CredentialProvider {
  constructor() {
    const ctx = new Context()
    super(ctx)
    onTestFinished(() => ctx.fiber.dispose())
  }

  override resolve(): never { throw new Error('Reference resolution is outside this fixture') }
  override describe(): never { throw new Error('Reference description is outside this fixture') }
  override set(): never { throw new Error('Reference writes are outside this fixture') }
  override unset(): never { throw new Error('Reference removal is outside this fixture') }
  override describeRecord(): never { throw new Error('Record description is outside this fixture') }
  override listRecords(): never { throw new Error('Record enumeration is outside this fixture') }
  record: CredentialRecord | undefined
  discardWrites = false
  reads = 0
  modifies = 0

  override readRecord(): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.record)
  }

  override async modifyRecord(
    _key: unknown,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    const next = await mutate(this.record)
    if (this.discardWrites) return undefined
    if (next !== undefined) this.record = next
    return this.record
  }

  override deleteRecord(): Promise<void> {
    this.record = undefined
    return Promise.resolve()
  }
}
