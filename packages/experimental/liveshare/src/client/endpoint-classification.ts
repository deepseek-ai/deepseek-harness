/**
 * Client-face completeness gate for the viewer endpoint classification.
 *
 * This module is compiled by the package's Client face, which pulls the production Remote maps in
 * through the Client assembly. `Extract<keyof TypertRemoteMap, string>` therefore names every endpoint
 * a shipped Client build can call; an endpoint added without a table row fails this declaration.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/endpoint-classification
 */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/remote'
import type { RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-cua/remote'
import type {} from '@deepseek-ai/dsh-experimental-api-speech-to-text/remote'
import type {} from '@deepseek-ai/dsh-experimental-claude-code-mods/remote'
import type {} from '@deepseek-ai/dsh-experimental-client-ui-cot-translation/remote'
import { VIEWER_ENDPOINT_CLASSES, type ViewerEndpointClass } from '../endpoint-classification.ts'

/**
 * The classification with every production Remote endpoint proven present.
 *
 * `satisfies` keeps the table's literal classes; a missing endpoint is a compile error here rather than
 * a runtime refusal that silently hides a reader surface.
 */
export const COMPLETE_VIEWER_ENDPOINT_CLASSES =
  VIEWER_ENDPOINT_CLASSES satisfies Record<RemoteEndpoint, ViewerEndpointClass>

/** An endpoint the generated map names but the table omits; `never` in a complete build. */
type UnclassifiedEndpoint = Exclude<RemoteEndpoint, keyof typeof VIEWER_ENDPOINT_CLASSES>

/** A table key the generated map does not name; `never` when the table has no stale rows. */
type UnknownClassifiedEndpoint = Exclude<keyof typeof VIEWER_ENDPOINT_CLASSES, RemoteEndpoint>

/** Fails the Client face unless `T` is `never`. */
type AssertNever<T extends never> = T

/** Compile-time proof that every generated endpoint has a class. */
export type NoUnclassifiedEndpoint = AssertNever<UnclassifiedEndpoint>

/** Compile-time proof that the table has no endpoint this Client build cannot name. */
export type NoUnknownClassifiedEndpoint = AssertNever<UnknownClassifiedEndpoint>
