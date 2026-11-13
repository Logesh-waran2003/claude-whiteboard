// Layout fixtures, shared with the quality benchmark. Plain JSON Canvas docs.
import type { CanvasDoc, CanvasEdge, GroupNode, LayoutKind, ShapeKind, TextNode } from '../core/model'

const BY = 'agent:fixture'

const node = (id: string, text: string, parent?: string, more: Partial<TextNode> = {}): TextNode => ({
  id, type: 'text', text, x: 0, y: 0, width: 0, height: 0, 'x-placed': false, 'x-by': BY,
  ...(parent ? { 'x-parent': parent } : {}),
  ...more,
})

const group = (id: string, label: string, layout: LayoutKind, more: Partial<GroupNode> = {}): GroupNode => ({
  id, type: 'group', label, x: 0, y: 0, width: 0, height: 0, 'x-placed': false, 'x-by': BY, 'x-layout': layout, ...more,
})

const edge = (id: string, fromNode: string, toNode: string, label?: string, more: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id, fromNode, toNode, 'x-by': BY, ...(label ? { label } : {}), ...more,
})

const placed = (id: string, text: string, x: number, y: number, more: Partial<TextNode> = {}): TextNode =>
  ({ id, type: 'text', text, x, y, width: 160, height: 64, 'x-by': BY, ...more })

/** 3 groups, 9 nodes, 8 labelled edges (4 cross-group), nothing placed. */
const architecture: CanvasDoc = {
  'x-layout': 'dag-tb',
  nodes: [
    group('browser', 'Browser', 'dag-lr'),
    group('server', 'Local server', 'dag-lr'),
    group('context', 'Context', 'dag-lr'),
    node('editor', 'Editor UI', 'browser'),
    node('canvas', 'Canvas renderer', 'browser'),
    node('chat', 'Chat panel', 'browser'),
    node('api', 'HTTP API', 'server'),
    node('store', 'Board store', 'server'),
    node('runner', 'Agent runner', 'server'),
    node('sdk', 'Claude Agent SDK', 'context'),
    node('mcp', 'MCP tools', 'context'),
    node('files', 'Project files', 'context', { 'x-shape': 'ellipse' }),
  ],
  edges: [
    edge('e1', 'editor', 'canvas', 'ops'),
    edge('e2', 'chat', 'api', 'prompt'),
    edge('e3', 'api', 'runner', 'start run'),
    edge('e4', 'runner', 'sdk', 'query'),
    edge('e5', 'sdk', 'mcp', 'tool call', { 'x-route': 'elbow' }),
    edge('e6', 'mcp', 'store', 'apply ops'),
    edge('e7', 'store', 'canvas', 'doc update'),
    edge('e8', 'sdk', 'files', 'reads'),
  ],
}

/** The bad case: placed boxes 40px apart, labels squeezed between them. */
const tight: CanvasDoc = {
  nodes: [
    placed('editor', 'Editor', 0, 0),
    placed('server', 'Server', 200, 0),
    placed('agent', 'Agent', 400, 0),
    placed('tools', 'Tools', 400, 104),
  ],
  edges: [
    edge('t1', 'editor', 'server', 'editor Ref'),
    edge('t2', 'server', 'agent', 'prompt'),
    edge('t3', 'agent', 'tools', '2. tool call'),
  ],
}

const sticky = (i: number, text: string): TextNode => node(`s${i}`, text, 'wall', { 'x-shape': 'sticky' as ShapeKind })

/** 12 unplaced stickies in a grid group; one has long text. */
const stickies: CanvasDoc = {
  nodes: [
    group('wall', 'Ideas', 'grid'),
    ...[
      'Undo', 'Dark mode', 'Export PNG', 'Share link', 'Comments', 'Templates',
      'Keyboard shortcuts for every tool, including the ones nobody remembers, with a cheat sheet on ? and a search box',
      'Presence', 'Minimap', 'Snap to grid', 'Frames', 'Version history',
    ].map((t, i) => sticky(i + 1, t)),
  ],
  edges: [],
}

/** A user-made node and a pinned node among agent nodes; two placed agent nodes crowd them. */
const mixed: CanvasDoc = {
  nodes: [
    placed('user', 'My idea (user)', 400, 200, { 'x-by': 'user' }),
    placed('pinned', 'Pinned note', 0, 400, { 'x-pin': true }),
    placed('a1', 'Agent near', 200, 200),
    placed('a2', 'Agent on top', 440, 230),
    placed('a6', 'Agent near pin', 100, 420),
    node('a3', 'Question'),
    node('a4', 'Answer with a longer explanation that wraps'),
    node('a5', 'Follow-up', undefined, { 'x-shape': 'diamond' }),
  ],
  edges: [
    edge('m1', 'a3', 'user', 'asks'),
    edge('m2', 'user', 'a4', 'answers'),
    edge('m3', 'a5', 'pinned', 'links to'),
    edge('m4', 'a1', 'user', 'feeds'),
  ],
}

/** The board the Mermaid importer built from a 3-subgraph flowchart; "Context" has no internal edges. */
const mermaid: CanvasDoc = {
  'x-layout': 'dag-tb',
  nodes: [
    group('browser', 'Browser', 'dag-lr'),
    group('server', 'Local server', 'dag-lr'),
    group('ctx', 'Context', 'dag-lr'),
    node('app', 'React app', 'browser'),
    node('canvas', 'Canvas view', 'browser'),
    node('chat', 'Chat panel', 'browser'),
    node('ws', 'Bun WebSocket', 'server'),
    node('sdk', 'Agent SDK', 'server'),
    node('mcp', 'Board MCP tools', 'server'),
    node('repo', 'Repo files', 'ctx'),
    node('notes', 'Obsidian notes', 'ctx'),
    node('brain', 'gbrain', 'ctx'),
  ],
  edges: [
    edge('app-canvas', 'app', 'canvas', 'editor ref'),
    edge('ws-sdk', 'ws', 'sdk', 'prompt'),
    edge('sdk-mcp', 'sdk', 'mcp', 'tool call'),
    edge('chat-ws', 'chat', 'ws', 'chat message'),
    edge('sdk-chat', 'sdk', 'chat', 'streamed reply'),
    edge('mcp-canvas', 'mcp', 'canvas', 'tool result'),
    edge('sdk-repo', 'sdk', 'repo', 'read'),
    edge('sdk-brain', 'sdk', 'brain', 'search'),
  ],
}

/** Several labelled edges between the same two nodes, both directions (one already elbow, as the importer does). */
const parallel: CanvasDoc = {
  'x-layout': 'dag-lr',
  nodes: [node('client', 'Client'), node('api', 'API'), node('db', 'Database')],
  edges: [
    edge('p1', 'client', 'api', 'request'),
    edge('p2', 'api', 'client', 'response', { 'x-route': 'elbow' }),
    edge('p3', 'client', 'api', 'retry'),
    edge('p4', 'api', 'db', 'query'),
  ],
}

/** The M7 board Claude drew of this app: 5 groups left to right, long cross-group edges, 3 edges on one side. */
const claudeApp: CanvasDoc = {
  'x-layout': 'dag-lr',
  nodes: [
    group('browser', 'Browser', 'dag-tb'),
    group('bun', 'Bun server', 'dag-tb'),
    group('sdk', 'Claude Agent SDK', 'dag-tb'),
    group('tools', 'Board MCP tools', 'dag-tb'),
    group('context', 'Context sources read-only', 'dag-tb'),
    node('app', 'React app', 'browser'),
    node('canvas', 'Canvas view', 'browser'),
    node('chat', 'Chat panel', 'browser'),
    node('routes', 'HTTP routes', 'bun'),
    node('ws', 'WebSocket hub', 'bun'),
    node('store', 'Board store', 'bun'),
    node('session', 'Agent session', 'bun'),
    node('claude', 'Claude opus effort low', 'sdk'),
    node('mcp', 'apply draw_mermaid read_board ...', 'tools'),
    node('projects', '~/Projects Read Glob Grep', 'context'),
    node('vault', 'Obsidian vault', 'context'),
    node('gbrain', 'gbrain MCP http', 'context'),
  ],
  edges: [
    edge('c1', 'app', 'canvas', 'renders'),
    edge('c2', 'chat', 'ws', 'chat message'),
    edge('c3', 'canvas', 'routes', 'save board'),
    edge('c4', 'routes', 'store', 'apply ops'),
    edge('c5', 'ws', 'session', 'prompt'),
    edge('c6', 'session', 'claude', 'query'),
    edge('c7', 'claude', 'mcp', 'tool call'),
    edge('c8', 'mcp', 'store', 'board ops'),
    edge('c9', 'store', 'canvas', 'doc update'),
    edge('c10', 'claude', 'projects', 'read files'),
    edge('c11', 'claude', 'vault', 'search notes'),
    edge('c12', 'claude', 'gbrain', 'recall'),
    edge('c13', 'session', 'chat', 'streamed reply'),
    edge('c14', 'store', 'ws', 'broadcast'),
    edge('c15', 'mcp', 'claude', 'tool result'),
  ],
}

export const fixtures = { architecture, tight, stickies, mixed, mermaid, parallel, 'claude-app': claudeApp } satisfies Record<string, CanvasDoc>
export type FixtureName = keyof typeof fixtures
