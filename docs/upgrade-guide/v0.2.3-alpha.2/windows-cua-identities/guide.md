---
kind: upgrade-guide
description: "Windows Computer Use requires renewed consent for application identities and returns opaque application selectors."
---

# Windows application permissions

English | [中文](guide.zh.md)

## Change

Windows Computer Use replaces grants based on self-declared AUMIDs with OS package application identities or canonical executable paths scoped by window AUMID. Old decisions do not authorize these new identities. The helper retires matching legacy decisions when the application is selected. Display names and icons do not determine permission scope. Application discovery returns opaque IDs that may differ from earlier AUMIDs or paths.

## Migration

1. Restart DSH with the updated Windows helper and all files from its build output. Restart every Host using the same profile.
2. Discover applications with `cua.listApps()` or `cua.findApps()`, and pass the returned ID unchanged to `cua.getApp()`. Replace stored discovery IDs in scripts; absolute executable paths remain accepted when they resolve to one application.
3. Confirm the application name and path in the new approval request. Choose session access or explicitly save access. Do not copy old `allowedApps` IDs into new grants.
4. Check the Computer Use plugin page. Selecting the application retires its matching legacy entries. Repeated selection of the same identity reuses the new decision; selecting a different executable requires its own consent.
