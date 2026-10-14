---
name: dsh-responsive-ui
description: Use when designing, implementing, or reviewing responsive client layouts, text truncation, title wrapping, icon-only controls, mobile hover, tooltips and keyboard behavior, and focus during width changes in DeepSeek Harness.
---

# Responsive client UI

## 1. Minimum viewport

Use a viewport width of 390 CSS px as the primary acceptance minimum. There must be no unintended overlap, clipping, page-wide horizontal scrolling, or inaccessible primary actions. Below 390px, layout requirements may be relaxed.

## 2. Decision order

1. First adjust space allocation or wrap elements onto another line; then consider text truncation, icon-only controls, or moving icons into the More menu.
2. Primary actions and primary states must not be omitted.
3. Do not hide conflicts through global clipping, reducing all font sizes, or shrinking click targets.
4. Reduce font sizes only when specifically required by product design.

## 3. Text truncation

1. Truncated content must be fully available on a secondary page or by opening a menu. Example: Session statistics below the input box.
2. Truncation must not lose errors or other key information.
3. Prefer single-line truncation for tab navigation, visible selectors, buttons, tags, and similar components.
4. Important information that is not available on another page must be displayed in full without truncation.

## 4. Titles

1. Prefer displaying page titles in full. Move the action area onto another line when necessary. Example: the Plugins page's title wrapping behavior.
2. Prefer natural wrapping for card titles. If the number of lines is limited, the full title must remain available to view.

## 5. Icon-only controls

1. Reducing a control to an icon requires both:
   - The icon clearly conveys its meaning, or the operation is familiar to users.
   - A tooltip appears on hover; add one if needed.
2. Do not reduce “More account information” to an icon, because it navigates to a separate page.
3. The model selector in the input box can be reduced to an icon because users see it frequently and can open its menu to switch models.
4. Another example is the linked conversation in an automation task.

## 6. Mobile hover behavior

1. Enable mouse-hover effects only on devices that support hovering. Use `@media (hover: hover)`, not viewport width, to determine this.
2. Tapping on a phone must not leave behind backgrounds, highlights, or action-button visibility intended only for hover.
3. Preserve normal selected, enabled, and pressed states, as well as focus indicators for keyboard interaction.
4. Try to preserve focus when the width changes, unless the focused element disappears from the page as a result.

## 7. Mobile tooltips

1. Do not show tooltips that only provide auxiliary information such as action names or keyboard shortcuts on mobile. For example, omit the “Copy” tooltip on a copy button; tapping still performs the original action directly.
2. Tooltips that provide supplementary explanations must support tap-to-show on mobile. For example, the information tooltip beside the Plugins page description.

## 8. Mobile keyboard

On mobile, do not raise the input keyboard automatically unless it is explicitly intended.
