# Discover toolbar responsive layout

- 390px: wrapped rows; index, search, labels, sort, and refresh are contained, reachable, and separate; no horizontal overflow; search focus retained.
- 430px: wrapped rows; index, search, labels, sort, and refresh are contained, reachable, and separate; no horizontal overflow; search focus retained.
- 768px: single row; index, search, labels, sort, and refresh are contained, reachable, and separate; no horizontal overflow; search focus retained.
- 1280px: single row; index, search, labels, sort, and refresh are contained, reachable, and separate; no horizontal overflow; search focus retained.

At 390px, restoring the previous no-wrap layout causes horizontal overflow and fails the same layout check. Removing that override restores the controls and preserves search focus.
