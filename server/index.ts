// Local server: owns the board file and runs Claude (Agent SDK, uses your Claude Code login).
// One Board + one AgentSession live here. Browsers keep a replica and send user ops over /ws;
// Claude changes the board through in-process board tools (canvas/agent/tools.ts).
import { type McpServerConfig, createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import type { ServerWebSocket } from 'bun'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { type Board, fromJSON } from '../canvas/core/board'
import { contains, nodeText } from '../canvas/core/geometry'
import { approxMeasure } from '../canvas/core/measure'
import type { CanvasDoc, Op } from '../canvas/core/model'
import { enforceInvariants } from '../canvas/layout/index'
import { AgentSession } from '../canvas/agent/session'
import { createTools } from '../canvas/agent/tools'

const HOME = homedir()
// What Claude may read (read-only). Set in .env (git-ignored); see .env.example.
const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, HOME))
const PROJECTS = expand(process.env.WB_CODE_DIR ?? `${import.meta.dir}/..`)
const VAULT = process.env.WB_NOTES_DIR ? expand(process.env.WB_NOTES_DIR) : undefined

const PORT = Number(process.env.PORT ?? 8792)
const MODEL = process.env.WB_MODEL ?? 'claude-opus-5-5'
const EFFORT = (process.env.WB_EFFORT ?? 'low') as 'low' | 'medium' | 'high'
const FILE = resolve(process.env.WB_BOARD ?? `${import.meta.dir}/../.board/main.canvas`)

const SYSTEM = `You work alongside the user on a shared whiteboard (a JSON Canvas board). The user edits the same board at the same time.

Board: you see and change it only through the board tools (mcp__board__*). Call get_skill once before your first board call and follow it.
Never delete or move the user's shapes unless they ask. When the user says "this" or "these", they mean the selected shapes (given with each message).

You can READ the user's work to ground your drawings (never invent architecture):
- Code: ${PROJECTS}. Use Glob/Grep/Read; start with README, package.json, docs.${VAULT ? `\n- Notes: ${VAULT} (markdown notes, plans).` : ''}
- gbrain (the user's knowledge base): mcp__gbrain__query / search / get_page, if available.
Read only what you need (a few files), then draw. If facts are missing, draw what you found and mark gaps with a grey "?" note.

Keep chat replies short: say what you changed in one or two lines.`

// ---------------------------------------------------------------- the board file

if (!existsSync(FILE)) {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify({ nodes: [], edges: [] }, null, 2) + '\n')
}
let board: Board = fromJSON(readFileSync(FILE, 'utf8'))
const session = new AgentSession(board, approxMeasure)
let diskText = readFileSync(FILE, 'utf8') // what the file holds (last read or written by us)
let diskMtime = statSync(FILE).mtimeMs
let saveTimer: ReturnType<typeof setTimeout> | undefined

function save() {
  saveTimer = undefined
  const text = board.toJSON() + '\n'
  if (text === diskText) return
  const tmp = `${FILE}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, FILE)
  diskText = text
  diskMtime = statSync(FILE).mtimeMs
}

/** Another editor (Obsidian, canvas/agent/mcp-stdio.ts) changed the file: load it while idle. */
function syncFromDisk() {
  if (running || saveTimer) return // never swap the board under Claude or over unsaved edits
  let mtime: number
  try {
    mtime = statSync(FILE).mtimeMs
  } catch {
    return
  }
  if (mtime === diskMtime) return
  diskMtime = mtime
  const text = readFileSync(FILE, 'utf8')
  if (text === diskText) return
  try {
    const next = fromJSON(text)
    diskText = text
    attach(next)
    session.load(next)
    broadcast('file')
  } catch (e) {
    console.error(`board: ignored unreadable ${FILE}: ${(e as Error).message}`)
  }
}
setInterval(syncFromDisk, 500)

// ---------------------------------------------------------------- clients

type Ws = ServerWebSocket<undefined>
const clients = new Set<Ws>()
let unsubscribe = () => {}
let lastBy = 'user'
let broadcastQueued = false

function docMsg(by: string, ack?: number) {
  return JSON.stringify({ type: 'doc', doc: board.doc, version: session.version, by, ack, canUndo: board.canUndo(), canRedo: board.canRedo(), file: basename(FILE) })
}

/** Send the doc to every tab. `ackTo` also gets the seq of its batch, so it can drop it from its pending list. */
function broadcast(by: string, ackTo?: { ws: Ws; seq: number }) {
  for (const ws of clients) ws.send(docMsg(by, ackTo?.ws === ws ? ackTo.seq : undefined))
}

/** Every change (user, Claude, undo) saves (debounced) and reaches all tabs (coalesced per tick). */
function attach(b: Board) {
  unsubscribe()
  board = b
  unsubscribe = b.subscribe(() => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 300)
    if (broadcastQueued) return
    broadcastQueued = true
    queueMicrotask(() => {
      broadcastQueued = false
      broadcast(lastBy)
    })
  })
}
attach(board)

/** A user batch from a tab. No auto-layout; only grow groups if a drop left a child outside its group. */
function applyUserOps(ws: Ws, msg: { ops: Op[]; seq: number; merge?: boolean }) {
  lastBy = 'user'
  const merge = !!msg.merge && lastUserWs === ws
  const r = board.apply(msg.ops, { by: 'user', mergeWithPrevious: merge })
  if (r.ok) {
    lastUserWs = ws
    const doc = board.doc
    const byId = new Map(doc.nodes.map((n) => [n.id, n]))
    const outside = doc.nodes.some((n) => {
      const g = n['x-parent'] && byId.get(n['x-parent'])
      return g && !contains(g, n)
    })
    const fix = outside ? enforceInvariants(doc, approxMeasure) : []
    if (fix.length) board.apply(fix, { by: 'layout', mergeWithPrevious: true })
  } else console.error('board: rejected user ops:', JSON.stringify(r.error))
  ws.send(docMsg('user', msg.seq)) // ack now (the coalesced broadcast follows for everyone)
}
let lastUserWs: Ws | null = null

// ---------------------------------------------------------------- Claude

let running: { abort: AbortController; ws: Ws } | null = null
const send = (ws: Ws | undefined, msg: unknown) => ws?.send(JSON.stringify(msg))

const asResult = (r: { text: string; isError?: boolean }) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) })

const TOOLS = createTools({
  session,
  agent: 'claude',
  onFocus: (ids) => {
    send(running?.ws, { type: 'focus', ids })
  },
})
const boardServer = createSdkMcpServer({
  name: 'board',
  tools: TOOLS.map((t) =>
    tool(t.name, t.description, t.inputSchema, async (args: unknown) => {
      lastBy = 'claude'
      const before = new Set([...session.doc.nodes, ...session.doc.edges].map((x) => x.id))
      const r = await t.run(args ?? {})
      // "Show on board" in the chat: what apply / draw_mermaid created. Their `ids` holds only
      // ref -> id pairs (draw_mermaid returns {}), so also take every id that is new on the board.
      if ((t.name === 'apply' || t.name === 'draw_mermaid') && !r.isError) {
        const ids = new Set([...session.doc.nodes, ...session.doc.edges].map((x) => x.id).filter((id) => !before.has(id)))
        try {
          for (const id of Object.values((JSON.parse(r.text) as { ids?: Record<string, string> }).ids ?? {})) ids.add(id)
        } catch {}
        if (ids.size) send(running?.ws, { type: 'shapes', ids: [...ids] })
      }
      return asResult(r)
    }),
  ),
})
const BOARD_TOOLS = TOOLS.map((t) => `mcp__board__${t.name}`)

// Read-only context: built-in file reads + gbrain search. No write, shell or web tools.
const READ_TOOLS = ['Read', 'Glob', 'Grep']
const GBRAIN_TOOLS = ['query', 'search', 'get_page'].map((t) => `mcp__gbrain__${t}`)

// gbrain MCP settings come from Claude Code's own config, so no token lives in this repo.
async function gbrainServer(): Promise<Record<string, McpServerConfig>> {
  try {
    const cfg = await Bun.file(`${HOME}/.claude.json`).json()
    const g = cfg.mcpServers?.gbrain
    return g?.type === 'http' ? { gbrain: { type: 'http' as const, url: g.url, headers: g.headers } } : {}
  } catch {
    return {}
  }
}
const GBRAIN = await gbrainServer()

type Viewport = { x: number; y: number; width: number; height: number }
type ChatMsg = { type: 'chat'; text: string; sessionId?: string; viewport?: Viewport; selected?: string[] }

/** What the user is looking at, sent with each message: "[Viewport ...] [Selected: ...]". */
function context(doc: CanvasDoc, msg: ChatMsg): string {
  const r = (n: number) => Math.round(n)
  const v = msg.viewport
  const parts = [v ? `[Viewport x=${r(v.x)} y=${r(v.y)} w=${r(v.width)} h=${r(v.height)}]` : '[Viewport unknown]']
  const sel = (msg.selected ?? []).flatMap((id) => {
    const n = doc.nodes.find((x) => x.id === id)
    if (n) return [`${n.id} [${n.type === 'group' ? 'group' : (n['x-shape'] ?? n.type)}] "${(n.type === 'group' ? (n.label ?? '') : nodeText(n)).slice(0, 80)}"`]
    const e = doc.edges.find((x) => x.id === id)
    return e ? [`${e.id}: ${e.fromNode} -> ${e.toNode}${e.label ? ` "${e.label}"` : ''}`] : []
  })
  parts.push(sel.length ? `[Selected:\n${sel.join('\n')}]` : '[Selected: none]')
  return parts.join(' ')
}

// One plain-language line per tool call, for the step trace in the chat panel.
const tidy = (p: unknown) => String(p ?? '').replace(`${PROJECTS}/`, '').replace(VAULT ? `${VAULT}/` : '\0', 'notes/').replace(HOME, '~')
function describeStep(name: string, i: Record<string, unknown>): { verb: string; detail?: string; code?: boolean } {
  const n = (k: string) => (Array.isArray(i[k]) ? (i[k] as unknown[]).length : 0)
  switch (name.replace(/^mcp__\w+?__/, '')) {
    case 'Read': return { verb: 'Read', detail: tidy(i.file_path), code: true }
    case 'Glob': return { verb: 'Looked for files', detail: tidy(i.pattern), code: true }
    case 'Grep': return { verb: 'Searched code for', detail: String(i.pattern), code: true }
    case 'query': case 'search': return { verb: 'Searched notes for', detail: String(i.query ?? '') }
    case 'get_page': return { verb: 'Opened note', detail: String(i.slug ?? ''), code: true }
    case 'get_skill': return { verb: 'Read the board guide' }
    case 'read_board': return { verb: 'Looked at the board' }
    case 'draw_mermaid': return { verb: 'Drew a diagram' }
    case 'apply': return { verb: 'Changed', detail: `${n('ops')} items` }
    case 'check': return { verb: 'Checked the layout' }
    case 'snapshot': return { verb: 'Took a snapshot' }
    case 'layout': return { verb: 'Re-arranged' }
    case 'find': return { verb: 'Searched the board' }
    case 'undo': return { verb: 'Undid its last change' }
    case 'focus': return { verb: 'Moved your view' }
    default: return { verb: name }
  }
}

async function runChat(ws: Ws, msg: ChatMsg) {
  const abort = new AbortController()
  running = { abort, ws }
  try {
    const q = query({
      prompt: `${context(board.doc, msg)}\n\n${msg.text}`,
      options: {
        model: MODEL,
        effort: EFFORT,
        systemPrompt: SYSTEM,
        tools: READ_TOOLS, // built-ins limited to read-only file tools
        cwd: PROJECTS,
        additionalDirectories: VAULT ? [VAULT] : [],
        allowedTools: [...BOARD_TOOLS, ...READ_TOOLS, ...GBRAIN_TOOLS],
        canUseTool: async (name) => ({ behavior: 'deny', message: `${name} is not allowed on the whiteboard (read-only).` }),
        mcpServers: { board: boardServer, ...GBRAIN },
        settingSources: [], // do not load CLAUDE.md, hooks or skills
        includePartialMessages: true,
        resume: msg.sessionId,
        abortController: abort,
      },
    })
    for await (const m of q) {
      if (m.type === 'stream_event') {
        const e = m.event
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') send(ws, { type: 'delta', text: e.delta.text })
        if (e.type === 'message_start') send(ws, { type: 'turn' })
      } else if (m.type === 'assistant') {
        for (const b of m.message.content) if (b.type === 'tool_use') send(ws, { type: 'step', ...describeStep(b.name, b.input as Record<string, unknown>) })
      } else if (m.type === 'result') {
        send(ws, { type: 'done', sessionId: m.session_id, ok: m.subtype === 'success' })
      }
    }
  } catch (err) {
    send(ws, { type: abort.signal.aborted ? 'done' : 'error', message: String(err), sessionId: msg.sessionId })
  } finally {
    running = null
    lastBy = 'user'
  }
}

// ---------------------------------------------------------------- HTTP + WebSocket

Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (new URL(req.url).pathname === '/ws' && server.upgrade(req)) return
    return new Response('agent-board server', { status: 200 })
  },
  websocket: {
    open(ws) {
      clients.add(ws)
      ws.send(docMsg('load'))
    },
    close(ws) {
      clients.delete(ws)
      if (lastUserWs === ws) lastUserWs = null
      const next = [...clients].at(-1)
      if (running?.ws === ws) next ? (running.ws = next) : running.abort.abort() // a reloaded tab picks up the run
    },
    message(ws, raw) {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'ops') applyUserOps(ws, msg)
      else if (msg.type === 'undo' || msg.type === 'redo') {
        lastBy = 'user'
        if (!(msg.type === 'undo' ? board.undo() : board.redo())) ws.send(docMsg('user'))
      } else if (msg.type === 'stop') running?.abort.abort()
      else if (msg.type === 'chat') {
        if (running) send(ws, { type: 'error', message: 'Claude is still working. Press Stop first.' })
        else void runChat(ws, msg)
      }
    },
  },
})
console.log(`server on :${PORT}  board=${FILE}  model=${MODEL} effort=${EFFORT} gbrain=${'gbrain' in GBRAIN}`)
