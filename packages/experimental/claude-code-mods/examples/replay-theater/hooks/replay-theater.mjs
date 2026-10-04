// Replay Theater, from "Getting started with Claude Code mods"
// (https://claude.dev/blog/getting-started-with-claude-code-mods/, Anthropic, 2026-10-01).
// The post publishes the five hooks that record edits and register /replay
// unchanged; the rest of the module (stepsFor, the diff, openReplay, the pane
// and the hint) is completed to the post's description, marked where it starts.

// Replay Theater: step through the last turn's edits, one diff at a time.

// —— completed to the post's description (not in the published excerpt) ——

const EDIT_TOOLS = new Set(["Edit", "Write"]);

// Edits of the running turn, the sealed replay of the last one, and where the pane is.
const state = { pending: [], replay: [], index: 0, open: false, placed: false };

export function register(on) {
  on("tool.call", async ($, e, next) => {
    if (EDIT_TOOLS.has(e.tool)) state.pending.push(...(await stepsFor($, e)));  // old/new text → diff
    return next(e);                                                              // the edit runs untouched
  });

  on("turn.start", ($, e, next) => { if (!e.agentId) state.pending = []; return next(e); });

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (!e.agentId && state.pending.length) state.replay = state.pending;       // one replay per turn
    return r;
  });

  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.command.register({ name: "replay", description: "Step through the last turn's file edits" });
    return r;
  });
  on("command.run", { command: "replay" }, async ($, e) => ({ text: (await openReplay($)) ? "Replaying" : "No edits" }));

  // —— completed to the post's description (not in the published excerpt) ——

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== "replay" || !state.open) return next(e);
    return theater($, e);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (state.open && !state.placed) return theater($, e);          // no pane could be placed: the same tree, inline
    if (state.open || state.replay.length === 0) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const n = state.replay.length;
    return Box({
      flexDirection: "row",
      paddingX: 1,
      gap: 1,
      children: [
        Text({ color: "magenta", bold: true, children: "Replay Theater" }),
        Text({ dimColor: true, children: `${n} edit${n === 1 ? "" : "s"} this turn — press r or type /replay` }),
        Button({ label: "Replay", hotkey: "r", onPress: () => openReplay($) }),
      ],
    });
  });
}

// One replay step per edit: the file, and the text before and after.
async function stepsFor($, e) {
  const file = String(e.file_path ?? "");
  if (e.tool === "Edit") {
    return [{ file, before: String(e.old_string ?? ""), after: String(e.new_string ?? "") }];
  }
  // For a Write, the old contents are read just before the write lands, so the diff is real.
  const before = await $.fs.read(file).catch(() => "");
  return [{ file, before, after: String(e.content ?? "") }];
}

async function openReplay($) {
  if (state.replay.length === 0) return false;
  state.index = 0;
  state.open = true;
  const opened = await $.ui.open({ id: "replay", title: "Replay Theater", focus: true });
  state.placed = opened.isPlaced;
  $.ui.invalidate("ui.render");
  return true;
}

function step(delta, $) {
  state.index = Math.min(Math.max(state.index + delta, 0), state.replay.length - 1);
  $.ui.invalidate("ui.render");
}

async function close($) {
  state.open = false;
  await $.ui.close({ id: "replay" });
  $.ui.invalidate("ui.render");
}

// Lines the edit removed and added, as a unified diff shows them.
function diffLines(before, after) {
  const old = before.split("\n");
  const neu = after.split("\n");
  const common = new Set(neu);
  const commonOld = new Set(old);
  return [
    ...old.filter((line) => !common.has(line)).map((line) => ({ sign: "-", line })),
    ...neu.filter((line) => !commonOld.has(line)).map((line) => ({ sign: "+", line })),
  ];
}

function theater($, e) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const current = state.replay[state.index];
  const strip = state.replay.map((_, i) => Text({ color: i === state.index ? "magenta" : undefined, bold: i === state.index, children: ` ${i + 1} ` }));
  const diff = diffLines(current.before, current.after).map(({ sign, line }) =>
    Text({ color: sign === "+" ? "green" : "red", children: `${sign} ${line}` }),
  );
  return Box({
    flexDirection: "column",
    border: true,
    borderColor: "magenta",
    paddingX: 1,
    children: [
      Box({ flexDirection: "row", children: [Text({ bold: true, children: "Replay Theater " }), ...strip] }),
      Text({ dimColor: true, children: `${current.file}  (step ${state.index + 1} of ${state.replay.length})` }),
      ...diff,
      Box({
        flexDirection: "row",
        gap: 2,
        children: [
          Button({ label: "Prev", hotkey: "p", disabled: state.index === 0, onPress: () => step(-1, $) }),
          Button({ label: "Next", hotkey: "n", disabled: state.index >= state.replay.length - 1, onPress: () => step(1, $) }),
          Button({ label: "Close", hotkey: "q", onPress: () => close($) }),
        ],
      }),
    ],
  });
}
