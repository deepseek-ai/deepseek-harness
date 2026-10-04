// Blast Radius, from "Getting started with Claude Code mods"
// (https://claude.dev/blog/getting-started-with-claude-code-mods/, Anthropic, 2026-10-01).
// The post publishes the tool.call hook below unchanged; the rest of the module
// (classify, measure, the pane and band trees) is completed to the post's
// description of the mod, which is marked where it starts.

// Blast Radius: see what a risky command would change before it runs.

// —— completed to the post's description (not in the published excerpt) ——

const RISKS = [
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, kind: "delete", what: "delete files recursively" },
  { pattern: /\bgit\s+reset\s+--hard\b/, kind: "reset", what: "discard uncommitted changes" },
  { pattern: /\bgit\s+clean\b/, kind: "clean", what: "delete untracked files" },
  { pattern: /\bgit\s+push\b[^\n]*\s(--force|-f)\b/, kind: "force-push", what: "rewrite a remote branch" },
  { pattern: /\b(migrate|manage\.py\s+migrate|prisma\s+migrate|rails\s+db:migrate)\b/, kind: "migrate", what: "change the database schema" },
];

// What the hook is holding: one command at a time, until a button decides.
let held = null;

export function register(on) {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const risk = classify(String(e.command ?? ""));
    if (risk === null) return next(e);                 // everything else runs as normal

    const report = await measure($, risk, await $.session.cwd());  // git status, git clean -n, du, ...
    held = { command: e.command, risk, report, decision: null };
    const opened = await $.ui.open({ id: "blast-radius", title: "Blast Radius", focus: true });
    if (!opened.isPlaced) held.where = "band";         // too narrow for a pane: draw above the prompt

    while (held.decision === null && !next.signal.aborted) {
      await $.process.run(["sleep", "0.25"]);          // time inside $ calls doesn't count against the hook's time limit
    }
    if (held.decision === "proceed") return next(e);   // let it run
    return { deny: `Blast Radius held this command: the user pressed Cancel. It would have: ${report.summary}.` };
  });

  // —— completed to the post's description (not in the published excerpt) ——

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== "blast-radius" || held === null || held.decision !== null) return next(e);
    return report($, e);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.decision !== null || held.where !== "band") return next(e);
    return report($, e);
  });
}

function classify(command) {
  const risk = RISKS.find((r) => r.pattern.test(command));
  return risk ? { kind: risk.kind, what: risk.what, command } : null;
}

async function measure($, risk, cwd) {
  const lines = [];
  let summary = `${risk.what} in ${cwd}`;
  if (risk.kind === "delete") {
    const target = risk.command.match(/\brm\s+-\S+\s+(\S+)/)?.[1];
    const du = await run($, ["du", "-sh", target ?? "."]);
    const size = du.stdout.trim().split(/\s+/)[0] ?? "?";
    const count = await run($, ["find", target ?? ".", "-type", "f"]);
    const files = count.stdout.split("\n").filter(Boolean).length;
    summary = `delete ${files} file(s) (${size}) under ${target ?? cwd}`;
    lines.push(...count.stdout.split("\n").filter(Boolean).slice(0, 9));
  } else if (risk.kind === "reset") {
    const status = await run($, ["git", "status", "--porcelain"]);
    const changed = status.stdout.split("\n").filter(Boolean);
    summary = `discard uncommitted changes to ${changed.length} file(s)`;
    lines.push(...changed.slice(0, 9));
  } else if (risk.kind === "clean") {
    const dry = await run($, ["git", "clean", "-n"]);
    const removed = dry.stdout.split("\n").filter(Boolean);
    summary = `delete ${removed.length} untracked path(s)`;
    lines.push(...removed.slice(0, 9));
  } else if (risk.kind === "force-push") {
    const ahead = await run($, ["git", "log", "--oneline", "HEAD..origin/main"]);
    const commits = ahead.stdout.split("\n").filter(Boolean);
    summary = `rewrite the remote branch, dropping ${commits.length} commit(s) not on this branch`;
    lines.push(...commits.slice(0, 9));
  } else if (risk.kind === "migrate") {
    const pending = await run($, ["sh", "-c", "python manage.py showmigrations --plan 2>/dev/null | grep '\\[ \\]' || true"]);
    const migrations = pending.stdout.split("\n").filter(Boolean);
    summary = `apply ${migrations.length} pending migration(s)`;
    lines.push(...migrations.slice(0, 9));
  }
  return { summary, lines };
}

// A dry run that fails (no git, no python, no such path) still lets the user decide.
async function run($, argv) {
  try {
    return await $.process.run(argv);
  } catch {
    return { exitCode: 1, stdout: "", stderr: "" };
  }
}

function decide(decision) {
  if (held !== null) held.decision = decision;
}

function report($, e) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const detail = held.report.lines.map((line) => Text({ dimColor: true, children: `  ${line}` }));
  return Box({
    flexDirection: "column",
    border: true,
    borderColor: "yellow",
    paddingX: 1,
    children: [
      Text({ color: "yellow", bold: true, children: `Blast Radius: ${held.command}` }),
      Text({ children: `Would ${held.report.summary}.` }),
      ...detail,
      Box({
        flexDirection: "row",
        gap: 2,
        children: [
          Button({ label: "Proceed", hotkey: "1", onPress: () => decide("proceed") }),
          Button({ label: "Cancel", hotkey: "2", onPress: () => decide("cancel") }),
        ],
      }),
    ],
  });
}
