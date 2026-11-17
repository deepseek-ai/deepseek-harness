/**
 * Source-only platform registrations for in-process browser assembly tests.
 *
 * `apps/web/tests/source-static-modules.client.ts` holds an identical copy:
 * a TypeScript test project cannot include a file outside its `rootDir`, so the `apps/web` project and
 * the package test projects each need their own. Change both together.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import * as Zod from 'zod'
import * as ReactVirtual from '@tanstack/react-virtual'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as UiDockkit from '@deepseek-ai/dsh-client-ui-dockkit'
import type { ClientModuleCreateOptions } from '@deepseek-ai/dsh-client-modules/client'
import type { PlatformModule } from '@deepseek-ai/dsh-client-web/src/platform.ts'

/**
 * Adapt source namespaces to the module registration protocol without compiled metadata.
 * @returns Registrations retaining the real source module namespace identities.
 */
export function getStaticModules(): ClientModuleCreateOptions['staticModules'] {
  const sources = {
    'react': React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    '@deepseek-ai/cordis': Cordis,
    'zod': Zod,
    '@tanstack/react-virtual': ReactVirtual,
    '@deepseek-ai/dsh-client-store': ClientStore,
    '@deepseek-ai/dsh-client-ui-slots': UiSlots,
    '@deepseek-ai/dsh-client-ui-primitives': UiPrimitives,
    '@deepseek-ai/dsh-client-ui-dockkit': UiDockkit,
  } satisfies Record<PlatformModule, Record<string, unknown>>
  return Object.entries(sources).map(([id, exports]) => ({ id, factory: () => exports }))
}
