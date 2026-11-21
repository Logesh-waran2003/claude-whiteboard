---
name: verify-ui
description: Check an Agent Board UI change in a real browser before you say it works. Use after any edit to src/** or canvas/render/**, or when asked to screenshot the board.
---

# Verify a UI change

The Playwright MCP extension and `chrome-devtools-axi` both failed on this machine (2026-11-22).
Use `playwright-core` with the cached Chromium in a scratch folder instead.

1. Make sure http://localhost:5181 is up (`lsof -ti :5181`). If not, start it detached:
   `nohup bun run dev >/tmp/board.log 2>&1 &`. Leave it running for Logesh.
2. Write the check in a scratch folder, never in the repo:

   ```bash
   mkdir -p ~/.t3/scratch/uicheck && cd ~/.t3/scratch/uicheck && bun add playwright-core
   ```

   ```js
   // check.mjs
   import { chromium } from 'playwright-core'
   const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
   const b = await chromium.launch({ executablePath: exe })
   const p = await b.newPage({ viewport: { width: 1300, height: 800 } })
   p.on('pageerror', (e) => console.log('ERR', e.message))
   await p.goto('http://localhost:5181'); await p.waitForTimeout(2500)
   // ...hover / click / evaluate, then:
   await p.screenshot({ path: '/tmp/ui.png' })
   await b.close()
   ```

3. Read `/tmp/ui.png` and judge it. Check light and dark mode when you change colours.
4. Seed state when you need it:
   - Chat messages: set `localStorage['wb-chat-v2']` to `[{id, role: 'user'|'claude', text}]`, then reload.
   - Board: `window.wb.board` (dev only) is the live board. Change it only through ops.
     Remember the board is Logesh's real file: do not leave test shapes on it.
5. Delete the scratch folder and screenshots when done.
