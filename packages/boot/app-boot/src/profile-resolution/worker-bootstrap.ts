/** Install an inherited profile resolution generation in one Harness-owned Worker. */

import { getEnvironmentData } from 'node:worker_threads'
import { installProfileResolution, type ProfileResolutionBehavior } from './resolver.ts'
import type { ProfileResolutionGeneration } from '../profile.ts'

const registration = getEnvironmentData(
  '@deepseek-ai/dsh-app-boot/profile-resolution',
) as {
  generation: ProfileResolutionGeneration
  behavior: ProfileResolutionBehavior
} | undefined
if (registration !== undefined) installProfileResolution(registration.generation, registration.behavior)
