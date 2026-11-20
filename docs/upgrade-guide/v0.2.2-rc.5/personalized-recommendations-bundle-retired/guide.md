---
kind: upgrade-guide
description: "The Personalized recommendations optional bundle is removed; the Web composition mounts its rows, on by default, behind a Settings → General switch."
---

# Personalized recommendations bundle removed

English | [中文](guide.zh.md)

## Change

In 0.2.2-rc.4, switching on Personalized recommendations in the Plugins page appended `@deepseek-ai/dsh-personalized-recommendations` to `dsh.profile.bundles` in `$DSH_HOME/profiles/<name>/package.json`. That bundle inserted the `action-cards`, `client-ui-action-cards`, `creation-recommendations`, `client-ui-creation-recommendations`, `plugin-recommendations`, and `client-ui-plugin-recommendations` rows; profiles without it offered no cards.

The next release removes the bundle. `@deepseek-ai/dsh-web-app` mounts the six rows with the same ids in every Web and Desktop profile, so cards are offered by default. Settings → General → Personalized recommendations writes `enabled` on the `action-cards` row: off, later requests no longer list the two card skills, and cards already shown keep working ([action cards](../../../../packages/interaction/action-cards/README.md)).

Loading a profile removes `@deepseek-ai/dsh-personalized-recommendations` from its `dsh.profile.bundles` and rewrites `package.json`; other manifest fields are kept. Cards in existing Sessions keep their state.

Row-level overrides in `cordis.patch.yml` and `--patch` overlays remain effective. For example, `disabled: true` on `creation-recommendations` prevents its skill from registering even while the General switch is on. Changing that switch does not enable disabled components, and the Plugins page no longer offers the old bundle's component switches.

## Migration

1. Before starting the upgraded profile, inspect `$DSH_HOME/profiles/<name>/cordis.patch.yml` and any `--patch` overlays for overrides on the six row ids above. To restore all components and use the General switch to control recommendations, remove their old `disabled: true` fields. Delete a whole override only when it contains nothing except `id`, an optional `name`, and `disabled`; otherwise keep its other fields and `config`.
2. To keep recommendations off after restoring the components, set `config.enabled: false` on the existing `action-cards` override. If none exists, add `- {id: action-cards, config: {enabled: false}}` to the profile's `cordis.patch.yml`. After startup, Settings → General → Personalized recommendations controls this value.
3. Start `dsh` once with each affected profile to remove the retired bundle selection automatically. A profile directory that another tool writes must drop the entry from `dsh.profile.bundles` itself.
4. Confirm: `dsh.profile.bundles` no longer lists the bundle, the Plugins page shows no failed Personalized recommendations entry, and Settings → General shows the Personalized recommendations switch. With all six components enabled and the switch on, a new Standard conversation can load both `official-plugins` and `personalized-pages`.
