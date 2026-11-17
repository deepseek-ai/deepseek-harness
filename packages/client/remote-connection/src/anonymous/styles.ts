/** Plugin-owned styles embedded in the anonymous script, with the same lifetime as its element. */
export const pairingStyles = `
dsh-device-pairing {
  display: block;
  min-width: 0;
}

.dsh-device-pairing-pairing {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  font-size: 13px;
  line-height: 1.5;
}

.dsh-device-pairing-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dsh-device-pairing-panel[hidden] {
  display: none;
}

.dsh-device-pairing-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.dsh-device-pairing-hint,
.dsh-device-pairing-message,
.dsh-device-pairing-countdown {
  margin: 0;
  color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 72%, transparent));
}

.dsh-device-pairing-countdown {
  flex: none;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dsh-device-pairing-message {
  min-width: 0;
  overflow-wrap: anywhere;
}

.dsh-device-pairing-message[role='alert'],
.dsh-device-pairing-panel[data-state='denied'] .dsh-device-pairing-message,
.dsh-device-pairing-panel[data-state='expired'] .dsh-device-pairing-message {
  grid-column: 1 / -1;
  padding: 12px;
  border: 0.5px solid color-mix(in srgb, var(--dsh-pairing-banner-color) 40%, transparent);
  border-radius: var(--dsw-radius-lg, 12px);
  color: var(--dsw-alias-label-primary, light-dark(#222, #eee));
  line-height: 20px;
}

.dsh-device-pairing-message[role='alert'] {
  --dsh-pairing-banner-color: var(--dsw-alias-state-error-primary, light-dark(#ec1313, #f25a5a));
  background: color-mix(in srgb, var(--dsh-pairing-banner-color) 10%, transparent);
}

.dsh-device-pairing-panel[data-state='denied'] .dsh-device-pairing-message,
.dsh-device-pairing-panel[data-state='expired'] .dsh-device-pairing-message {
  --dsh-pairing-banner-color: var(--dsw-alias-state-warn-primary, light-dark(#bd720b, #e7a53c));
  background: var(--dsw-alias-state-warn-tertiary, color-mix(in srgb, var(--dsh-pairing-banner-color) 10%, transparent));
}

.dsh-device-pairing-code {
  padding: 8px 0;
  text-align: center;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, monospace);
  font-size: 24px;
  font-weight: 500;
  letter-spacing: 3px;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary, light-dark(#222, #eee));
}

.dsh-device-pairing-feedback {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.dsh-device-pairing-countdown {
  grid-column: 2;
}

.dsh-device-pairing-button {
  box-sizing: border-box;
  min-height: 44px;
  padding: 8px 12px;
  font: inherit;
  font-weight: 500;
  border: 0.5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent));
  border-radius: var(--dsw-radius-sm, 8px);
  color: var(--dsw-alias-label-primary, light-dark(#222, #eee));
  background: var(--dsw-alias-bg-layer-1, light-dark(#fff, #232324));
  cursor: pointer;
}

.dsh-device-pairing-button:disabled {
  cursor: default;
}

.dsh-device-pairing-button:disabled:not(.dsh-device-pairing-primary) {
  color: var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 48%, transparent));
}

.dsh-device-pairing-button:focus-visible {
  outline-style: solid;
  outline-offset: 2px;
}

.dsh-device-pairing-primary {
  font-size: 14px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary-foreground, light-dark(#fff, #222));
  background: var(--dsw-alias-button-primary-fill, light-dark(#222, #eee));
  border: 0;
}

@media (hover: hover) {
  .dsh-device-pairing-button:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover, light-dark(#f5f5f5, #303031));
  }

  .dsh-device-pairing-primary:hover:not(:disabled) {
    background: var(--dsw-alias-button-primary-hover, light-dark(#3c3c3d, #d4d4d4));
  }
}
`
