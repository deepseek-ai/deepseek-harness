# Verify in the available environment

Prefer the authenticated page already connected to Harness. Do not launch a separate browser from shell commands, change `HOME`, inspect personal browser profiles, search for authentication tokens, or alter keychains to obtain a screenshot. For a visual-only request without browser control, limit verification to JavaScript syntax, manifest validation, and the live Client slot, then report that visual verification remains unavailable. Before or after installation, do not search for rasterizers, invoke Quick Look, extract SVG into preview files, emulate React/DOM, or implement a custom renderer to compensate for missing browser control. A screenshot of a mock page is not verification of the running plugin.

For a page or panel, verify that styles use only theme tokens, the plugin imports no Harness Client package such as `@deepseek-ai/dsh-client-ui-primitives`, the console shows no slot entry crash, and the view reads correctly in light and dark themes beside a comparable host page. Scale verification to the change's risk.

For any test subprocess or temporary resource, use a unique owned directory, bound execution, and await cleanup. A failed optional preview must not turn into environment repair or block installation.
