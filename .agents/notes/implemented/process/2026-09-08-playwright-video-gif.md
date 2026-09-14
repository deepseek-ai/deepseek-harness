# Agent Note: Playwright video captures continuous browser demos

Status: implemented

English | [中文](2026-09-08-playwright-video-gif.zh.md)

## Problem

A screenshot storyboard omits intermediate animation frames and can miss short-lived progress indicators. Increasing the encoded GIF frame rate cannot recover motion absent from its source images. Continuous capture supplies those frames while the available browser-control workflow handles interaction.

## Decision

The [recording skill](../../../skills/record-browser-gif/SKILL.md) keeps the available browser-control workflow preferred. When that workflow exposes `recordVideo`, video captures intermediate frames in the same controlled context; otherwise the workflow captures screenshots. Standalone repository-declared Playwright remains the fallback when browser control is unavailable. For video, viewport and recording dimensions match explicitly, avoiding Playwright's default scaling to fit 800×800. The recorder retains the page video, awaits context closure, and saves the completed WebM before encoding.

One encoder accepts either a video file or a screenshot directory. Video input selects one continuous interval, applies a declared playback multiplier, and extends its final frame. The JSON summary records source duration, selected interval, speed, final hold, and encoded dimensions, duration, frame count, and size. Mode-inappropriate options and invalid intervals fail. The original video remains available for review; trimming and speed never establish model response latency.

The [evidence-chain decision](2026-08-08-browser-gif-evidence-chain.md) owns browser-control selection, isolated application state, real model execution, exact commit attribution, and verified publication. Video adds a higher-cadence capture option within those rules. Failed recordings cannot contribute frames to a successful run.

## Alternatives considered

**Increase only the encoded frame rate.** Repeating sparse screenshots does not capture additional motion. Screenshots remain useful for explicit state holds, requested storyboards, and browser workflows without video support.

**Install a separate recorder or capture the desktop.** The repository already declares Playwright. Another driver adds setup and version management; desktop capture can include unrelated windows and personal state.

## Consequences

Continuous recording preserves intermediate states, so reviewers must inspect the selected interval for sensitive content and readability. Raw video consumes additional scratch storage, and encoding may require trimming or scaling to meet the byte limit. Context closure is part of successful recording, not optional cleanup.

The encoder's local Python unittest suite invokes real ffmpeg and ffprobe to check timing, palette order, screenshot holds, rejected options, overwrite protection, and size limits. It requires the skill's media prerequisites and is run explicitly; repository CI does not provision these media binaries. Product demonstrations additionally exercise the pull request's built server and real model flow.
