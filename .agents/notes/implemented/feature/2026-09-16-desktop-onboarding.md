# Agent Note: Device-local Desktop onboarding

Status: implemented

English | [中文](2026-09-16-desktop-onboarding.zh.md)

## Problem

Account users need an introduction to credit and display choices after native authentication. The native credential entry already has a separate startup responsibility; repeating browser onboarding or treating missing account data as a new user would couple presentation to authentication failures.

## Decision

The [account UI](../../../../packages/client/ui-settings-account/README.md#desktop-onboarding) mounts one shell overlay only when the Desktop preload marker exists, an account credential is stored, and the local introduction is unfinished. Host settings own versioned progress and completion for the installation, without a Platform completion flag or per-account history. Restart resumes the saved step; signing out hides the introduction without erasing it. A signed-out installation with configured model credentials records API-key completion after applying standard process, detailed usage, and enabled developer tools. Account sign-in discards a failed API-key completion write so retry cannot bypass the required welcome page.

Welcome requires an explicit start. The credit page always appears, including for positive balances. Only a ready balance with no positive wallet triggers the additional continue-without-credit confirmation; failed or pending queries never imply zero. Returning from native recharge retains the credit page while the account owner refreshes details. Closing the application during recharge retains the credit step.

Purpose and process selections persist as drafts. Office-only completion selects compact presentation. Development or both purposes require a process choice. Skipping any supported step selects standard process with compact usage and developer tools off. Completion applies Chat and shared developer-tool preferences before saving the done marker so a refused preference write cannot silently finish onboarding. Compact, standard, and detailed persist their corresponding `ui-chat.transcriptView` values.

The existing [native welcome decision](../architecture/2026-09-08-desktop-welcome-window-material.md) owns credential entry, IPC restrictions, and window material. Desktop suppresses automatic Web credential onboarding while retaining explicit API-key editing. Onboarding creates no workspace, demonstration task, or Session event. Static Figma illustrations use transparent, palette-compressed 3× PNG assets; welcome layers are merged with local sidebar blur; recharge uses a 70% opaque foreground window with local blur of the covered illustration. The account package owns the full-window overlay and its control styling; shared primitives retain generic behavior. Brand headings load a bundled, licensed Montserrat WOFF2 font through the Web entry. Choices retain focus during writes, reduced-motion preferences disable animation, and the application remains inert until the exit overlay unmounts. The confirmation dialog blurs its source page instead of sampling another backdrop in the translucent window.

## Alternatives considered

**Cloud or per-account completion.** The current release requires device-local progress and has no account completion API. Reusing login state as completion would conflate successful authentication with finished setup.

**Skipping credit for positive balances or waiting for recharge confirmation.** The introduction explains billing independently of wallet state. Waiting for a balance query would turn return navigation into a network-dependent action without establishing whether a payment completed.

**Duplicating preference controls.** Onboarding writes work details, usage, and developer tools through their existing owners.

## Consequences

An existing API-key installation without an onboarding completion marker also receives these defaults on its first upgraded launch, replacing any prior Chat display, usage, and developer-tools preferences. Installations already marked complete retain their preferences.

One installation's completion applies across account changes, and another installation runs its own introduction. Preference and completion writes are ordered but are not one transaction; retry can reapply the same preference after a failed completion write. Completed installations do not reapply preferences on subsequent launches. The [controller tests](../../../../packages/client/ui-settings-account/tests/onboarding-state.client.spec.ts) and [UI tests](../../../../packages/client/ui-settings-account/tests/desktop-onboarding.client.spec.tsx) own state and interaction coverage; production authorization and payment behavior remain separate integration validation.
