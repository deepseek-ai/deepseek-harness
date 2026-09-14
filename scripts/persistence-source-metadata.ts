/** Stable source-file metadata for saved persistence inventories. */

import type { PersistenceSchemaInventory } from './persistence-schema-model.ts'

/**
 * Remove source line positions without changing schemas, names, or fingerprints.
 * @param inventory - validated inventory whose source metadata will be copied.
 * @returns an inventory with unique source paths in their original order.
 */
export function withoutPersistenceSourceLines(inventory: PersistenceSchemaInventory): PersistenceSchemaInventory {
  return {
    ...inventory,
    types: inventory.types.map(type => ({
      ...type,
      sources: [...new Set(type.sources.map(source => source.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/u, '')))],
    })),
  }
}
