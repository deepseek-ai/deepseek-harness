/**
 * Web question plugin, node half.
 *
 * Mounting `ask_user_question` in the tools registry's global layer expands
 * every agent's tool list regardless of its preset. Rendering a question is
 * a host UI capability; the model-facing tool belongs to the presets that
 * include it and to the TUI composition, which has no presets.
 */

/** Host plugin body — the model-facing tool is composed per preset, not here. */
export function apply(): void {}
