// M5. MCP stdio server for one board file.
// Usage: bun canvas/agent/mcp-stdio.ts --file <path.canvas> [--agent <name>]
// Saves after every change (tmp + rename). Reloads when the file changed on disk (checked before each call).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fromJSON } from '../core/board'
import { approxMeasure } from '../core/measure'
import { AgentSession } from './session'
import { createTools } from './tools'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const fileArg = arg('file')
if (!fileArg) {
  console.error('usage: bun canvas/agent/mcp-stdio.ts --file <path.canvas> [--agent <name>]')
  process.exit(2)
}
const file = resolve(fileArg)
const agent = arg('agent') ?? 'mcp'

if (!existsSync(file)) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ nodes: [], edges: [] }, null, 2) + '\n')
}
let mtime = statSync(file).mtimeMs
const session = new AgentSession(fromJSON(readFileSync(file, 'utf8')), approxMeasure)

function save() {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(session.doc, null, 2) + '\n')
  renameSync(tmp, file)
  mtime = statSync(file).mtimeMs
}

/** Another editor (Obsidian, the app) changed the file while we were idle: load it. */
function syncFromDisk() {
  const now = statSync(file).mtimeMs
  if (now === mtime) return
  try {
    session.load(fromJSON(readFileSync(file, 'utf8')))
    mtime = now
  } catch (e) {
    console.error(`board: ignored unreadable ${file}: ${(e as Error).message}`)
  }
}

const server = new McpServer(
  { name: 'board', version: '0.1.0' },
  {
    instructions:
      'Shared whiteboard (a JSON Canvas file). Call get_skill once before any other board tool and follow it: read_board first, prefer draw_mermaid for new diagrams, fix every quality problem a write reports.',
  },
)

for (const tool of createTools({ session, agent })) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args: unknown) => {
    syncFromDisk()
    const before = session.version
    const r = await tool.run(args ?? {})
    if (session.version !== before) save()
    return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) }
  })
}

await server.connect(new StdioServerTransport())
console.error(`board MCP server: ${file} (agent ${agent})`)
