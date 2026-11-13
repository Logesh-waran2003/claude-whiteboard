// CONTRACT (M0). Shared by core, layout, render and quality. Change only with the main thread.
//
// The board is a JSON Canvas 1.0 document (https://jsoncanvas.org/spec/1.0/) with `x-` extension
// fields. Obsidian can open our files; unknown fields must survive load -> save.
// Coordinates are absolute page pixels (JSON Canvas has no nesting). Group membership is `x-parent`.

export type Color = '1' | '2' | '3' | '4' | '5' | '6' | `#${string}` // JSON Canvas: 1 red 2 orange 3 yellow 4 green 5 cyan 6 purple
export type Side = 'top' | 'right' | 'bottom' | 'left'
export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }

/** Visual shape of a node. JSON Canvas `type` stays text/file/link/group; we add the look. */
export type ShapeKind = 'rect' | 'ellipse' | 'diamond' | 'sticky' | 'text'
/** How a group (or the root, id "root") arranges its direct children. */
export type LayoutKind = 'dag-lr' | 'dag-tb' | 'grid' | 'free'

export type NodeBase = Rect & {
  id: string
  color?: Color
  /** Who made it: "user" or "agent:<name>". The engine never moves user shapes unless asked. */
  'x-by'?: string
  /** true = the layout engine must not move or resize it. */
  'x-pin'?: boolean
  /** Containing group id. Absent = top level. */
  'x-parent'?: string
  /** Free semantic tag the agent uses, e.g. "service", "datastore", "actor". */
  'x-role'?: string
  /** false = not placed yet; the layout engine positions it. Absent = placed. */
  'x-placed'?: boolean
  [extra: `x-${string}`]: unknown
}

export type TextNode = NodeBase & { type: 'text'; text: string; 'x-shape'?: ShapeKind }
export type FileNode = NodeBase & { type: 'file'; file: string; subpath?: string; 'x-shape'?: ShapeKind }
export type LinkNode = NodeBase & { type: 'link'; url: string; 'x-shape'?: ShapeKind }
export type GroupNode = NodeBase & {
  type: 'group'
  label?: string
  background?: string
  backgroundStyle?: 'cover' | 'ratio' | 'repeat'
  'x-layout'?: LayoutKind
}
export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode

export type CanvasEdge = {
  id: string
  fromNode: string
  toNode: string
  fromSide?: Side
  toSide?: Side
  fromEnd?: 'none' | 'arrow'
  toEnd?: 'none' | 'arrow' // JSON Canvas default: "arrow"
  color?: Color
  label?: string
  'x-by'?: string
  /** Route style. Default "straight". */
  'x-route'?: 'straight' | 'elbow'
  /** Absolute waypoints between the two ends, written by the layout engine. Ends are computed. */
  'x-points'?: Point[]
  [extra: `x-${string}`]: unknown
}

/** Nodes are in z-order (first = bottom). Groups should come before their children. */
export type CanvasDoc = {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  /** Root layout. */
  'x-layout'?: LayoutKind
  [extra: `x-${string}`]: unknown
}

// ---------------------------------------------------------------- Ops (the ONLY way to change a board)
// Humans (renderer), agents (MCP) and the layout engine all emit ops. One op log = one undo stack.
// `ref` lets later ops in the same batch point at a node created earlier in the batch.
// Anywhere an id is accepted, a ref from the same batch is accepted too.

export type NodeFields = {
  kind?: ShapeKind | 'group' // default "rect"; "group" makes a GroupNode
  text?: string // TextNode text, or GroupNode label
  file?: string // makes a FileNode
  url?: string // makes a LinkNode
  x?: number // omit x AND y -> x-placed=false, the layout engine places it
  y?: number
  width?: number // omit -> sized from text by the layout engine
  height?: number
  color?: Color
  parent?: string // group id/ref; "" on update = remove from its group
  role?: string
  pin?: boolean
  layout?: LayoutKind // groups only
}

export type Op =
  | ({ op: 'add_node'; ref?: string; id?: string } & NodeFields)
  | { op: 'add_edge'; ref?: string; id?: string; from: string; to: string; label?: string; fromSide?: Side; toSide?: Side; color?: Color; route?: 'straight' | 'elbow'; arrow?: 'none' | 'end' | 'both' }
  | ({ op: 'update'; id: string } & NodeFields) // nodes; for edges use update_edge
  | { op: 'update_edge'; id: string; label?: string; color?: Color; route?: 'straight' | 'elbow'; points?: Point[]; fromSide?: Side; toSide?: Side }
  | { op: 'move'; ids: string[]; dx: number; dy: number } // moves group children with the group
  | { op: 'remove'; ids: string[] } // nodes or edges; removing a node removes its edges; removing a group keeps children (un-parents them)
  | { op: 'set_layout'; group: string; layout: LayoutKind } // group id or "root"
  | { op: 'reorder'; id: string; to: 'front' | 'back' }

export type OpError = { opIndex: number; field?: string; message: string }

export type ApplyOk = { ok: true; version: number; ids: Record<string, string> }
export type ApplyFail = { ok: false; version: number; error: OpError | { stale: true; message: string; diff: BoardDiff } }
export type ApplyResult = ApplyOk | ApplyFail

/** What changed between two versions. Node and edge ids share one id space; "root" (reserved) = top-level doc fields. */
export type BoardDiff = { from: number; to: number; added: string[]; changed: string[]; removed: string[] }

export type ApplyOptions = {
  /** Actor written to x-by on new items: "user" | "agent:<name>" | "layout". */
  by: string
  /** If set and not equal to the current version, the batch is rejected with the diff (optimistic concurrency). */
  baseVersion?: number
  /** Merge into the previous undo step (used for drag frames and for layout after an agent batch). */
  mergeWithPrevious?: boolean
}

// ---------------------------------------------------------------- Quality report (M6 computes it)

export type QualityReport = {
  /** Text boxes (nodes or edge labels) that overlap: ids of both. Must be [] to pass. */
  overlaps: [string, string][]
  /** Edge ids whose label had to wrap to fit. Must be [] to pass. */
  wraps: string[]
  /** Edges that pass through a node that is not one of their ends. */
  edgeThroughNode: [edgeId: string, nodeId: string][]
  /** Nodes with x-parent that are not fully inside their group. */
  outsideGroup: string[]
  /** Count of edge pairs that cross. */
  crossings: number
  /** Bounding area of all nodes, px². Smaller is tighter. */
  area: number
  /** 0..100. 100 = no problems. Formula in quality/score.ts. */
  score: number
}

// ---------------------------------------------------------------- Text measurement (injected)

export type FontSize = number
export type Measure = (text: string, opts: { fontSize: FontSize; maxWidth?: number }) => { width: number; height: number }

/** Typography shared by layout, renderer and quality, so all three agree on sizes. */
export const TYPE = {
  nodeFontSize: 16,
  labelFontSize: 14,
  groupLabelFontSize: 14,
  lineHeight: 1.35,
  nodePadding: 16,
  labelPadding: 4,
  minNode: { width: 160, height: 64 },
  maxNodeWidth: 320,
  sticky: { width: 200, height: 200 },
  groupPadding: 40,
  groupLabelHeight: 28,
  gap: 48, // min space between siblings
  edgeLabelGap: 160, // min space between two nodes joined by a labelled edge
} as const

// ---------------------------------------------------------------- Board store API (M1 implements it in core/board.ts)

/**
 * The live board. `doc` is IMMUTABLE: every successful apply/undo/redo replaces it with a new object
 * (unchanged nodes/edges keep their identity), so React can compare by reference.
 */
export interface BoardApi {
  readonly doc: CanvasDoc
  readonly version: number
  /** Validates the whole batch first; applies all or nothing. One batch = one undo step (unless mergeWithPrevious). */
  apply(ops: Op[], opts: ApplyOptions): ApplyResult
  undo(): boolean
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean
  diffSince(version: number): BoardDiff
  /** Called after every change. Returns unsubscribe. */
  subscribe(fn: (doc: CanvasDoc, version: number) => void): () => void
  /** JSON Canvas text (2-space indent). Unknown fields preserved. */
  toJSON(): string
}
