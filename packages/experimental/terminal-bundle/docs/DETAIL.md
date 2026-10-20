![A dev server keeps running in the agent's terminal; a later tool call reads its new output](preview.svg)

This plugin gives the agent terminal tools that keep a persistent background and environment: processes keep running in the background, and the current directory, exported variables, and shell functions carry over between tool calls. The agent can start a dev server, a file watcher, a debugger, or a REPL, make other tool calls while it runs, and come back later to read new output or type more input.

## How to use

- Ask for work that keeps running, for example "start the dev server in a terminal and check its output after the edit".
- Each terminal step appears in the conversation as a tool call: **Open terminal**, a terminal card with the text sent and its output, **Read terminal**, **Signal terminal**, **List terminals**, and **Close terminal**.
- The terminals belong to the agent: you see them through these tool calls and cannot type into them yourself. The sidebar terminal is separate: it is your own shell, and the agent does not see it. Only the agent that opened a terminal can use it. macOS and Linux use Bash; Windows uses PowerShell.

## Good to know

- A terminal starts in the session's current folder and runs under its access mode. While a terminal is open, you cannot switch to an access mode with different file access; have the agent close its terminals first.
- Output the agent reads is added to the conversation and uses tokens; each result is capped at 256 KB by default.
- Full-screen terminal programs are not supported.
- Terminals stop when DSH restarts or this plugin is turned off. Keep results that must last in files.
- Turning this plugin on or off changes the tools of open sessions. Their next request cannot reuse the prompt cache, so it is slower and costs more once.
