// M5. Tool definitions shared by the MCP stdio server and the in-app server.
// Descriptions are prompts for the model: what the tool does, when to use it, what it returns.
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Op } from '../core/model'
import type { AgentSession } from './session'

export const REFERENCES = ['architecture', 'flow', 'sequence', 'er', 'stickies', 'matrix', 'stages', 'timeline'] as const

export type ToolContext = {
  session: AgentSession
  /** Agent name; writes are tagged "agent:<name>". */
  agent: string
  /** Moves the user's camera to these ids. Absent in stdio mode. */
  onFocus?: (ids: string[]) => void | Promise<void>
  /** SVG -> PNG. When set, snapshot returns a picture the model can look at. */
  png?: (svg: string) => Promise<Uint8Array>
}

export type ToolResult = { text: string; isError?: boolean; /** base64 PNG shown to the model */ image?: string }

export type ToolDef = {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  run: (args: any) => ToolResult | Promise<ToolResult>
}

const LAYOUTS = z.enum(['dag-lr', 'dag-tb', 'grid', 'free', 'row', 'column'])

const json = (v: unknown, isError = false): ToolResult => ({ text: JSON.stringify(v, null, 1), isError })
const write = (r: { ok: boolean }) => json(r, !r.ok)

export function readSkill(name?: string): string {
  const rel = name ? `./skill/references/${name}.md` : './skill/SKILL.md'
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

const OPS_HELP = `Op shapes (ids or same-batch refs work anywhere an id is expected):
{"op":"add_node","ref":"a","text":"Auth","kind":"rect|ellipse|diamond|sticky|text|card|group","parent":"<group>","role":"service"}
{"op":"add_node","kind":"card","text":"Title\nshort body line","color":"4","progress":70,"parent":"<lane>"}   (card: first line = bold title; progress 0-100 = bar)
{"op":"add_edge","from":"a","to":"b","label":"calls","arrow":"end|none|both","route":"straight|elbow"}
{"op":"update","id":"n1","text":"New name","parent":"g2"}   (parent "" = take out of its group)
{"op":"update_edge","id":"e1","label":"reads"}
{"op":"move","ids":["n1"],"dx":0,"dy":120}  {"op":"remove","ids":["n1","e2"]}
{"op":"set_layout","group":"g1|root","layout":"dag-lr|dag-tb|grid|free|row|column"}   (row/column: children in one line, in add order — lanes)  {"op":"reorder","id":"n1","to":"front|back"}
Omit x/y/width/height: the engine places and sizes new nodes.`

export function createTools(ctx: ToolContext): ToolDef[] {
  const { session, agent } = ctx
  return [
    {
      name: 'get_skill',
      description:
        'Returns the board skill: how to draw reliable diagrams with these tools. Call it once before your first board call. Pass name to get one diagram-type reference (architecture, flow, sequence, er, stickies, matrix, stages, timeline).',
      inputSchema: { name: z.enum(REFERENCES).optional().describe('Reference to load; omit for the main skill') },
      run: ({ name }) => ({ text: readSkill(name) }),
    },
    {
      name: 'read_board',
      description:
        'Read the shared board. Call it before every write. Returns the version, the changes others made since your last read ("user moved n3"), and an outline: one line per node `id [kind] "text" @x,y wxh in:<group> role:<r> by:<who>`, groups as headers with children indented, then edges `id: from -> to "label"`. detail "full" also returns the raw JSON Canvas.',
      inputSchema: { detail: z.enum(['outline', 'full']).optional() },
      run: ({ detail }) => {
        const r = session.readBoard({ agent, detail })
        const parts = [`version ${r.version}`]
        parts.push(r.diff.length ? `changes since your last read:\n${r.diff.map((l) => '- ' + l).join('\n')}` : 'changes since your last read: none')
        parts.push(r.outline)
        if (r.doc) parts.push(JSON.stringify(r.doc))
        return { text: parts.join('\n\n') }
      },
    },
    {
      name: 'apply',
      description: `Change the board with a batch of ops (all or nothing; one undo step). Use for edits: rename, add a few nodes, connect, regroup, remove your own shapes. The engine then places new nodes, tidies, and scores. Returns {ok, version, ids (ref -> id), quality {score, overlaps, wraps, edgeThroughNode, outsideGroup, crossings}, tidied, hint}. On error nothing changes; read error + hint and resend.\n${OPS_HELP}`,
      inputSchema: {
        ops: z.array(z.looseObject({ op: z.enum(['add_node', 'add_edge', 'update', 'update_edge', 'move', 'remove', 'set_layout', 'reorder']) })).describe('Ops, applied in order'),
        baseVersion: z.number().int().optional().describe('Version from read_board; rejects the batch if the board changed since'),
      },
      run: ({ ops, baseVersion }) => write(session.apply({ agent, ops: ops as Op[], baseVersion })),
    },
    {
      name: 'draw_mermaid',
      description:
        'Draw a new diagram from a Mermaid flowchart (flowchart/graph TD|LR, [rect] (round) ((ellipse)) {diamond}, -->, ---, -.->, ==>, -- label -->, -->|label|, A --> B & C, nested subgraph id [Title] ... end with direction LR). Preferred for flows and architecture. Mermaid ids become board ids; an id that already exists on the board is reused, so you can connect to existing nodes. Returns the same result as apply, plus warnings.',
      inputSchema: {
        source: z.string().describe('Mermaid flowchart text'),
        parent: z.string().optional().describe('Existing group id to draw inside'),
        layout: LAYOUTS.optional().describe('Override the container layout'),
      },
      run: ({ source, parent, layout }) => write(session.fromMermaid({ agent, source, parent, layout })),
    },
    {
      name: 'layout',
      description:
        'Re-run the layout engine. Default: place unplaced nodes and fit groups. scope = a group id to lay out only that group. all = true re-lays out everything that is not pinned or user-made (use when quality is poor). One undo step. Returns {ok, version, quality, tidied, hint}.',
      inputSchema: { scope: z.string().optional(), all: z.boolean().optional() },
      run: ({ scope, all }) => write(session.layout({ agent, scope, all })),
    },
    {
      name: 'check',
      description:
        'Score the whole board. Returns {score 0-100, overlaps, wraps, edgeThroughNode, outsideGroup, crossings, area, hint}. 100 = no problems. Writes already return quality, so use this after the user edits.',
      inputSchema: {},
      run: () => json(session.check()),
    },
    {
      name: 'find',
      description:
        'Find nodes by text (case-insensitive substring; also matches edge labels), file path, or role. Returns one outline line per match. Use it to get ids before an edit instead of reading the whole board.',
      inputSchema: { text: z.string().optional(), file: z.string().optional(), role: z.string().optional() },
      run: (args) => {
        const lines = session.find(args)
        return { text: lines.length ? lines.join('\n') : 'no matches' }
      },
    },
    {
      name: 'snapshot',
      description:
        'Render the board (or only some ids; groups include their children) as a picture (PNG) you can look at. Use it to judge your drawing like a human would (the 5-second test in the skill). format "svg" returns SVG text instead.',
      inputSchema: { ids: z.array(z.string()).optional(), padding: z.number().optional(), format: z.enum(['png', 'svg']).optional() },
      run: async ({ ids, padding, format }) => {
        const svg = session.snapshot({ ids, padding })
        if (format === 'svg' || !ctx.png) return { text: svg }
        try {
          const png = await ctx.png(svg)
          return { text: 'Snapshot of the board (PNG).', image: Buffer.from(png).toString('base64') }
        } catch (e) {
          return { text: `PNG failed (${(e as Error).message}); SVG instead:\n${svg}` }
        }
      },
    },
    {
      name: 'undo',
      description:
        'Undo your last write (its ops and the layout together). Refuses if anyone changed the board after it, so it never undoes user work.',
      inputSchema: {},
      run: () => {
        const r = session.undo({ agent })
        return json(r, !r.ok)
      },
    },
    {
      name: 'focus',
      description: 'Move the user\'s view to these ids (e.g. after you draw). Does nothing when no app is attached.',
      inputSchema: { ids: z.array(z.string()).min(1) },
      run: async ({ ids }) => {
        if (!ctx.onFocus) return { text: 'No app attached (stdio mode); focus is a no-op. Tell the user which ids to look at.' }
        await ctx.onFocus(ids)
        return { text: `Focused on ${ids.join(', ')}` }
      },
    },
  ]
}
