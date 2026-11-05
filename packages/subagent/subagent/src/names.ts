/**
 * Model-facing agent names. Each child's name is unique among its creator's
 * children and is recorded in the creator's catalog; a member's full name is
 * the slash-separated path of names from the root, whose own name is `lead`.
 *
 * @module @deepseek-ai/dsh-subagent/names
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentError } from './error.ts'

/** The root agent's fixed name; no child may take it. */
export const ROOT_AGENT_NAME = 'lead'

/** One lower-case segment of at most 32 characters, so a 36-character UUID never matches. */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u

/**
 * Whether a string is a valid child name.
 * @param value - candidate name segment.
 * @returns true for 1–32 lower-case letters, digits, or hyphens starting with a letter, other than `lead`.
 */
export function isAgentName(value: string): boolean {
  return NAME_PATTERN.test(value) && value !== ROOT_AGENT_NAME
}

/**
 * Append a child's name to its creator's path. The root's path is the empty string.
 * @param parentPath - the creator's path, or undefined when an ancestor below the root has no name.
 * @param name - the child's catalog name, absent on historical entries.
 * @returns the child's path, or undefined when any link is unnamed.
 */
export function joinAgentPath(parentPath: string | undefined, name: string | undefined): string | undefined {
  if (parentPath === undefined || name === undefined) return undefined
  return parentPath === '' ? name : `${parentPath}/${name}`
}

/**
 * Select the model-facing name of one tree member.
 * @param path - the member's path; `''` for the root and undefined for unnamed history.
 * @param id - the member's Session id, used when no complete path exists.
 * @returns `lead`, the full path, or the Session id.
 */
export function agentAddress(path: string | undefined, id: string): string {
  if (path === '') return ROOT_AGENT_NAME
  return path ?? id
}

/**
 * Remove the last name from a descendant path.
 * @param path - a non-empty descendant path.
 * @returns the creator's path; `''` when the creator is the root.
 */
export function parentAgentPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? '' : path.slice(0, separator)
}

/** A sibling name held from admission until the creator's catalog commits or startup fails. */
export interface SiblingNameReservation {
  readonly name: string
  /** Return the name to the pool; repeated calls are harmless. */
  release(): void
}

/** Names claimed by in-flight creations, keyed by the exact live creator. */
export class SiblingNameReservations {
  private readonly pending = new Map<Agent, Set<string>>()

  /**
   * Claim a name synchronously before startup awaits, so concurrent siblings cannot share it.
   * @param parent - exact live creator whose catalog receives the name.
   * @param committed - names already recorded in the creator's catalog.
   * @param requested - requested name; omission selects the first free `agent-N`.
   * @returns the claimed name and its release.
   * @throws {@link SubagentError} `INVALID_AGENT_NAME` or `DUPLICATE_AGENT_NAME`.
   */
  reserve(parent: Agent, committed: ReadonlySet<string>, requested?: string): SiblingNameReservation {
    const pending = this.pending.get(parent) ?? new Set<string>()
    const taken = (name: string): boolean => committed.has(name) || pending.has(name)
    let name: string
    if (requested === undefined) {
      let ordinal = 1
      while (taken(`agent-${ordinal}`)) ordinal++
      name = `agent-${ordinal}`
    } else {
      if (!isAgentName(requested)) {
        throw new SubagentError(
          `agent name ${JSON.stringify(requested)} is invalid; use 1-32 lower-case letters, digits, or hyphens `
          + `starting with a letter, other than "${ROOT_AGENT_NAME}"`,
          'INVALID_AGENT_NAME',
        )
      }
      if (taken(requested)) {
        throw new SubagentError(
          `agent name ${JSON.stringify(requested)} is already used by another subagent you created; choose another name`,
          'DUPLICATE_AGENT_NAME',
        )
      }
      name = requested
    }
    pending.add(name)
    this.pending.set(parent, pending)
    return {
      name,
      release: () => {
        pending.delete(name)
        // A later reservation for the same creator replaces the set; a stale release must not drop it.
        if (pending.size === 0 && this.pending.get(parent) === pending) this.pending.delete(parent)
      },
    }
  }
}
