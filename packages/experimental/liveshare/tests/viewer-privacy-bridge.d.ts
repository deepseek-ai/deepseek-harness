/** Test-only request/response boundary between the Host reader and built Viewer fixture. */
import type { ViewerAnswer, ViewerRequest } from '../src/viewer-channel.ts'

/** A share-bound reader; identity and Host context remain inside its provider. */
export interface PrivacyOwnerReader {
  /** Decide one Viewer request under the fixture's share and actor. */
  answer(request: ViewerRequest, signal?: AbortSignal): Promise<ViewerAnswer>
  /** Release the reader's requests and streams. */
  close(): void
}

/** Host provider loaded at runtime without merging Host and Client compiler contexts. */
export interface PrivacyOwnerModule {
  readonly createPrivacyOwnerReader: (dispatch: (request: Request) => Promise<Response>) => PrivacyOwnerReader
}
