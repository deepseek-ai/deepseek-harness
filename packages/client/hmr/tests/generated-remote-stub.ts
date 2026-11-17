/**
 * Resolvable stand-in for the generated `./remote` contribution when this package has no built `lib/`.
 * It declares the one stream endpoint the Client face mounts, so whole-client specs exercise the real
 * `$mount` path; its item schema accepts any JSON value instead of the generated frame validation.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

export default createTypertRemoteInfo({
  package: '@deepseek-ai/dsh-client-hmr',
  methods: {
    'pluginEvents/follow': {
      service: 'pluginEvents',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-client-hmr/types#PluginsEventFrame',
        create: () => z.json(),
        jsonSchema: {},
      },
    },
  },
}, z)
