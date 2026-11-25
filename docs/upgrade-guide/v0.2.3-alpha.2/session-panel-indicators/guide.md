---
kind: upgrade-guide
description: "Plugins that relied on the Session panel toggle to turn their output into a dot must now style the indicator themselves."
---

# Draw indicators on the Session panel toggle

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, a plugin registered in `conversation.session.panel.indicator` could set a background on an element and provide status text: the toggle sized the element, rounded it, and drew its ring. After upgrading, the toggle positions a shared 6×6 px container at the icon's top-right corner. It does not style the elements inside, so a background alone may leave no visible dot.

## Migration

1. Keep the registration's `id`, `order`, and any `panelShown` check. Return `null` when there is nothing to report. When showing a dot, keep the localized status text inside the element and hide it visually so the toggle's accessible name still includes it.
2. Apply a class to the element your plugin renders, not to the shared container. For example, the following rule fills the available area and draws a round dot with a ring. Use the background color for your status.

   ```css
   .indicator {
     position: absolute;
     inset: 0;
     border-radius: 50%;
     corner-shape: round;
     background: var(--dsw-alias-state-business-primary);
     box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-base);
   }
   ```

3. With only your status active, check the dot at the top-right of the icon and the status text in the toggle's accessible name. Clear the status: the dot, ring, and status text should disappear. With two indicators active, the one with the higher `order` paints on top.
