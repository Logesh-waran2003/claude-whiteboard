# AGENTS.md — Agent Board

Read this file first. Then read `docs/HANDOFF.md` (state, decisions, known gaps).

## What this is
A local whiteboard. You and AI agents edit the same board. The board is one JSON Canvas file
(`.board/main.canvas`, git-ignored). Agents send a graph (ops or Mermaid). The layout engine places it.
The scorer reports quality on every write. A Claude chat panel sits on the right side of the board.

- Repo: `Logesh-waran2003/claude-whiteboard` on GitHub, **private**. Personal account, never a team org.
- Package manager: **bun** (`bun.lock`). Do not use npm, pnpm or yarn.
- Owner: Logesh. Product name: Agent Board (`agent-board`).

## Run and check
| Task | Command |
|---|---|
| Install | `bun install` |
| Dev (web 5181 + server 8792) | `bun run dev` → http://localhost:5181 |
| Tests (190, must stay green) | `bun run test` |
| Types | `bun run typecheck` |
| Agent end-to-end (score must be 100) | `bun canvas/agent/e2e.ts` |
| CLI | `bun run board check\|render\|import\|layout\|new\|mcp` |

Ports 8787 and 8790 belong to other local tools. Never stop port 3100 (gbrain).
If 5181 is already running, it is Logesh's live board: use it, do not kill it.
Personal read paths live in `.env` (git-ignored). `.env.example` lists the keys.

## Map
| Path | What lives there |
|---|---|
| `canvas/core/model.ts` | The shared contract (types, ops). **Only the main thread edits it.** |
| `canvas/core/board.ts` | Store, op log, undo |
| `canvas/layout/**` | Layout engine and auto-tidy |
| `canvas/quality/**` | Quality scorer |
| `canvas/render/**` | Our own canvas renderer (`BoardView.tsx`). No tldraw. |
| `canvas/agent/**` | Board tools, MCP server, Mermaid import, PNG/SVG export |
| `canvas/agent/skill/` | The `board` skill that drawing agents load (`get_skill`) |
| `server/index.ts` | Owns the board file, WebSocket, runs the Claude Agent SDK chat |
| `src/App.tsx` | App shell: board bar (top left), board nav (left edge), dots toggle |
| `src/Chat.tsx` | Chat panel |
| `docs/HANDOFF.md` | Current state. Update it when you finish work. |

## Rules
1. Every board change goes through ops (`BoardApi.apply`). Never mutate `doc` directly.
2. Check visual quality with a render or screenshot, not only the score.
3. Smallest change that works. Reuse what exists. No new dependency without a reason.
4. Keep the chat window simple. Board navigation and board settings belong on the board, not in the chat
   (Logesh asked for this on 2026-11-22).
5. UI settings that only change the view (theme, dots) use a `data-*` attribute on `<html>` plus one CSS rule,
   saved in `localStorage`. Do not pass a prop through the renderer for them.
6. Use the existing CSS variables in `src/styles.css` (`--ink`, `--graphite`, `--rule`, `--paper`, `--marker`).
   Every UI change must work in light and dark mode.
7. Before you say "done": `bun run test` and `bun run typecheck` pass, and you looked at a screenshot
   (see skill `verify-ui` in `.claude/skills/`).
8. Leave no scratch files in the repo. Use `~/.t3/scratch/` for throwaway scripts.

## Git
- Commit or push only after Logesh says go. A go covers that one push.
- Never add AI attribution (no "Co-Authored-By: Claude", no "Generated with") to commits or PRs.
- Never commit `.env`, `.board/` or `node_modules` (all git-ignored).
- Branch `main`, remote `origin`. Short commit messages that say what changed.

## UI features (so you do not rebuild them)
| Feature | Where | How it works |
|---|---|---|
| Board nav | `BoardNav` in `src/App.tsx` | One line per top-level group, left edge. Hover = title + contents. Click = zoom to it. |
| Dots toggle | `DotsToggle` in `src/App.tsx` | Sets `html[data-dots]`; `.wb-dots` rect in `BoardView.tsx` hides. Key `wb-dots`. |
| Theme | `ThemeToggle` in `src/App.tsx` | `html[data-theme]`; `index.html` applies it before first paint. |
| Chat minimise | `src/Chat.tsx` | Cmd+\ toggles. Width and open state in `localStorage`. |
| Chat history | `localStorage` key `wb-chat-v2` | Saved in the browser, not on the server. |
