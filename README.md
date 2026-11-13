# Agent Board

Local infinite canvas (our own renderer, `canvas/`) with a Claude chat that edits the board live, next to you.

    bun install
    bun run dev        # open http://localhost:5181

- Uses your Claude Code login through the Claude Agent SDK. No API key.
- The server owns the board: one JSON Canvas file, default `.board/main.canvas` (set `WB_BOARD=/path/x.canvas`).
  It saves after every change and reloads when another editor (Obsidian, `canvas/agent/mcp-stdio.ts`) writes the file.
  Every open tab shows the same board; undo/redo is shared.
- Claude has the board tools from `canvas/agent/tools.ts` (get_skill, read_board, apply, draw_mermaid, layout, check,
  find, snapshot, undo, focus) plus read-only Read/Glob/Grep and gbrain.
- Select shapes, then say "these". Chat history is saved in the browser.
- Chat panel: step trace (what Claude read and drew), Show on board, markdown replies, Copy, Try again,
  Esc to stop, drag the left edge to resize, the > button to hide it.
- Board bar (top left): file name, live quality score, Clean/Sketch, Undo/Redo.
- Model and effort: `WB_MODEL=claude-opus-5-5 WB_EFFORT=low bun run dev`. Server port (default 8792): `PORT=8797 bun run dev`
  (Vite proxies `/ws` to the same port).
