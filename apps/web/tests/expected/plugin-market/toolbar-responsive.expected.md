# Discover toolbar responsive layout

- 390px: wrapped rows; index, search, labels, sort, and refresh are contained, reachable, and separate; no horizontal overflow; search focus retained.
- 430px: wrapped rows; index, search, labels, sort, and refresh are contained, reachable, and separate; no horizontal overflow; search focus retained.
- 768px: single row; index, search, labels, sort, and refresh are contained, reachable, and separate; no horizontal overflow; search focus retained.
- 1280px: single row; index, search, labels, sort, and refresh are contained, reachable, and separate; no horizontal overflow; search focus retained.

The source dialog treats a Raw URL and an unmarked custom URL as JSON. It shows Git fields for an SSH clone address or a git+https URL. The fields fit and stay reachable at 390px and 1280px. Editing the address preserves the Git draft, and Escape closes the dialog.

At 390px, restoring the previous no-wrap layout causes horizontal overflow and fails the same layout check. Removing that override restores the controls and preserves search focus.
