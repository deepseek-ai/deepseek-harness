/**
 * Program faces of the repository's Typert pass. The Host face alone emits
 * Host reflection and the Host-for-Client Remote projection; no package
 * publishes Client reflection. The Host tsdown plugin (`tsdown.config.ts`)
 * and the bundle-free pass (`generate-typert.ts`) both generate exactly these
 * faces. Node loads this module through type stripping from
 * `tsdown.config.ts`, so it uses only erasable TypeScript syntax.
 */
export const WORKSPACE_TYPERT_FACES = ['host'] as const
