# Verify in the available environment

Prefer the authenticated page already connected to Harness. Do not launch a separate browser from shell commands, change `HOME`, inspect personal browser profiles, search for authentication tokens, or alter keychains to obtain a screenshot. For a visual-only request without browser control, limit verification to JavaScript syntax, manifest validation, and, with inspection tools, the live Client slot, then report that visual verification remains unavailable. Before or after installation, do not search for rasterizers, invoke Quick Look, extract SVG into preview files, emulate React/DOM, or implement a custom renderer to compensate for missing browser control. A screenshot of a mock page is not verification of the running plugin.

For a page or panel, verify that styles use only theme tokens, the plugin imports no Harness Client package such as `@deepseek-ai/dsh-client-ui-primitives`, the console shows no slot entry crash, and the view reads correctly in light and dark themes beside a comparable host page. Scale verification to the change's risk.

For any test subprocess or temporary resource, use a unique owned directory, bound execution, and await cleanup. A failed optional preview must not turn into environment repair or block installation.

## User experience review

Before delivering a new plugin or a change to its user experience, run one UI/UX expert review through a subagent; without a subagent tool, perform the same review yourself and say so. Give the reviewer the user's goal, the plugin's location, and the available running-UI evidence. Ask it to check discoverability, the main user flow, feedback, and visual consistency. Apply the verification limits above when browser control is unavailable, and report any review or verification that could not run. Fix substantiated issues within the requested scope and verify the affected behavior before finishing.
