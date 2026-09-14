# Agent Note: Responsive Sidebar and injected tab information

Status: implemented

English | [中文](2026-09-07-sidebar-responsive-tab-info.zh.md)

## Problem

Tab extensions need consistent live information about their containing pane and Sidebar without a growing list of owner props. The workbench must also preserve content while adapting to limited viewport space, without reopening a Sidebar the user has closed.

## Decision

The slot framework injects one `useTabInfo()` returning nested `sidebar`, `panel`, and `tab` fields. It composes the framework-bound layout and navigation hooks; extensions neither subscribe themselves nor receive a service object. Body visibility requires an active tab in an expanded Sidebar; title visibility does not require an active tab. Hiding or switching Sessions leaves the tab lifetime intact. Closing the record aborts its signal. Tab actions stay bound to their owning Session. Store adoption is a private capability of the plugin assembly, not a public controller operation.

The frame protects 400px for the conversation by shrinking the right column, then closing it before shrinking the conversation. Its first-open preference is 45% of the viewport, retained thereafter in pixels, with a 300px floor and 70% viewport ceiling. The left column keeps its preference at widths of at least 1024px. Closing is recorded state: widening never opens it, while a user action or explicit Session API may. Refresh restores defaults rather than persisting layout.

Fullscreen uses the same mounted content tree and covers the viewport while retaining the underlying column reservation. Opening below 768px selects automatic fullscreen; exiting it there closes the Sidebar. Widening can end automatic fullscreen but leaves manually selected fullscreen intact. The product permits two horizontal panes, a 50/50 initial split, and a 20–80% divider; narrow panes refuse new splits. The generic docking engine retains its independent capabilities. A fullscreen entry completes its slide before reporting the underlying track; that covered width change is instantaneous, so neither entry nor returning to normal reveals a background reflow. At the two-pane budget the split control is hidden; a one-pane width refusal remains disabled. On exit, the frame prepares the destination before the overlay retreats: no right track for close, a normal track for restore. Transition suppression survives clearing the fullscreen report and ends on the next geometry action.

This decision supersedes the flat owner-props choice in [tab types and navigation](2026-09-05-sidebar-tab-types-and-navigation.md) and the no-concession, overlay presentation and product pane limit in [docking infrastructure](../feature/2026-09-04-right-sidebar-docking-infrastructure.md). Their registration, record-lifetime, state ownership and engine-selection rationale remain active.

## Alternatives considered

**Flat information props or three separate hooks.** A single nested read groups the three ownership levels and allows additional fields without proliferating props or readers.

**Automatic reopening after a viewport change.** It makes opening depend on layout history rather than an explicit action. A closed Sidebar stays closed, with its content preserved.

**A separate fullscreen content tree.** Remounting would interrupt tab-local state. The same element changes presentation instead.

## Consequences

Tab extensions use a framework-injected reader and keep their own store actions separate from `tab.actions`. Layout, seat and docking tests cover width concessions, explicit reopening, body/title visibility, tab lifetimes, horizontal drop zones and divider limits; browser tests exercise the assembled application. Compact mobile controls and layout persistence remain outside this decision.
