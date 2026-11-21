# Handoff — Agent Board (2026-11-13)

Read `AGENTS.md` (repo rules) and this file, then `docs/plan.html` (research, spec, Gantt, tracker).

## What it is
A local, open-source whiteboard where you and AI agents edit the same board. Agents send a **graph**
(ops or Mermaid), a layout engine places it, auto-tidy fixes overlaps, and a scorer reports quality on
every write. Boards are **JSON Canvas** files (Obsidian opens them). Our own canvas (tldraw removed).

## State
| Milestone | State |
|---|---|
| M0 contract `canvas/core/model.ts`, `geometry.ts`, `measure.ts` | ✅ |
| M1 store + op log + undo `canvas/core/board.ts` | ✅ 66 tests |
| M2/M3 renderer + canvas UX `canvas/render/**` | ✅ 31 tests, 60 fps at 1,000 nodes |
| M4 layout + auto-tidy `canvas/layout/**` | ✅ 16 tests; 6/7 fixtures 100, claude-app 92 (4 straight-edge crossings) |
| M5 agent layer, MCP, skill `canvas/agent/**` | ✅ 23 tests; MCP e2e scores 100 |
| M6 quality scorer `canvas/quality/**` | ✅ 28 tests |
| M7 app on our canvas (`server/`, `src/`) | ✅ server owns `.board/main.canvas`; tabs + disk sync; real Claude run works |
| M8 CLI `canvas/cli/main.ts` | ✅ 16 tests; `bun run board check|render|import|layout|new|mcp` |
| Images (2026-11-13) | ✅ paste/drop on canvas + attach/paste/drop in chat; stored in `.board/assets/<sha256-16>.<ext>`, served at `/assets`; Claude gets chat images as image blocks |
| Visual boards (2026-11-13) | ✅ `card` shape (title + body + `progress` bar), `row`/`column` layouts (lanes), skill step "pick the picture" + 5-second test, refs `stages` + `timeline`, `snapshot` returns PNG (headless Chrome, `canvas/agent/png.ts`). Real run: status → lanes of cards (100), "where did time go" → timeline (100) |
| UI (2026-11-13) | ✅ "Back to content" button when no shape is on screen; chat minimise button + floating "Claude" pill, Cmd+\ toggles |
| UI (2026-11-22) | ✅ Board nav on the left edge (one line per diagram, hover preview, click to zoom); Hide/Show dots toggle in the board bar |
| M9 launch prep | ⏳ paths moved to `.env` (git-ignored). Needs decisions below |

Proof: `bun run test` → 190 pass · `bun run typecheck` clean · `bun canvas/agent/e2e.ts` → score 100.

## Run
`bun run dev` → http://localhost:5181 (server port 8792; 8787/8790 are used by other local tools).
Personal read paths live in `.env` (see `.env.example`).

## Decisions waiting on Logesh
1. ✅ Product name: Agent Board (`agent-board`), chosen 2026-11-13.
2. Licence (recommended MIT).
3. ✅ `git init` + first local commit done 2026-11-13. ✅ Pushed 2026-11-22 to private repo `Logesh-waran2003/claude-whiteboard`. Making it public = separate go.

## Known gaps
- 4 crossings on the claude-app fixture (straight edges are not re-routed only for crossings).
- Undo history resets when the server restarts or reloads the file.
- Not verified: real trackpad pinch, system clipboard with other apps, PNG export on Linux.
- Chat effort default is now `high` (`WB_EFFORT`). Image nodes are not in SVG/PNG export (`canvas/agent/export-svg.ts`) yet.
- Scorer fix: an outer group no longer counts as "on the border" of a group nested in it (was -10 on every nested diagram).
- `snapshot` PNG needs Google Chrome; without it the tool falls back to SVG text.
- Score uses `approxMeasure` in CLI/server; the browser badge uses exact canvas measure.

## Rules for this repo
- Only the main thread edits `canvas/core/model.ts` (the shared contract).
- Every board change goes through ops (`BoardApi.apply`); never mutate `doc`.
- Check visual quality with a render, not only the score.
