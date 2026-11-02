/** Host half of Connectors: the `connectors` service, present while the Connectors bundle is enabled. */
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present while the Connectors bundle is enabled; each official connector bundle's row injects it. */
    connectors: Connectors
  }
}

/** Present while the Connectors bundle is enabled; a connector row that injects it runs only then. */
export class Connectors extends Service {
  /** @param ctx - the Host plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'connectors')
  }
}

export default Connectors
