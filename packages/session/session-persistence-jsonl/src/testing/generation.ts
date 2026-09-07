import {
  createJsonlGenerationRuntime,
  type JsonlGenerationRuntime,
  type JsonlGenerationRuntimeOverrides,
} from '../generation.ts'

/**
 * Create generation operations with deterministic I/O and race seams for tests.
 * @param overrides - deterministic filesystem, platform, and race dependencies.
 * @returns bound generation operations.
 */
export function createJsonlGenerationTestRuntime(
  overrides: JsonlGenerationRuntimeOverrides = {},
): JsonlGenerationRuntime {
  return createJsonlGenerationRuntime(overrides)
}
