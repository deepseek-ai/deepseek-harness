# Timeline changelog

## Harness integration

This entry corresponds to Timeline 0.4.0. The integrated package uses the Harness release version.

- Find Timeline under **Plugins → More** as an experimental Harness plugin. It is off by default. Set up task tracking and reports from the plugin detail page.
- Switch report levels with a smooth column transition. The report grid keeps its place, and the interface follows the system setting for reduced motion.
- Type `/timeline` to open Timeline and see command help. Import a saved plan with `/timeline @plan.timeline.json`. Add `--copy` to make a separate copy or `--continue` to ask the agent to resume work.
- Fork a session with its saved task trees, progress, and discussions at the fork point. Each fork has its own report history and work requests.

To bring a plan from the standalone plugin into Harness Timeline, export it as a `.timeline.json` file and import it into the new plugin.
