---
name: board
description: Draw on the shared whiteboard (a JSON Canvas file). Use any time the user wants a diagram, map, board, flow, architecture, sticky clustering or 2x2 matrix on the shared board.
---

# Board

The board is a JSON Canvas file in the repo. You describe a graph; the engine places,
sizes, routes and scores it. Every write returns `quality`.

## Steps

1. Call `read_board`. Read `changes since your last read` first: the user may have
   moved, renamed or removed shapes.
2. Get facts first. Read the repo, notes or the user's message. Never invent nodes or
   edges. For a fact you cannot find, add a node with `role: "gap"` and text `?`
   (Mermaid: `gap1[?]`, then `apply` `{"op":"update","id":"gap1","role":"gap"}`).
3. Pick the diagram type. Load its reference with `get_skill({name})`:
   `architecture`, `flow`, `sequence`, `er`, `stickies`, `matrix`.
4. Describe a GRAPH, not pixels.
   - New flow or architecture: `draw_mermaid`.
   - Edits (rename, connect, regroup, remove): `apply` with ops.
   - Omit x, y, width and height. The engine places new shapes.
   - Use `find` to get ids before an edit.
5. Keep labels short: a node has 6 words or fewer, an edge label 1 to 3 words.
   One concept per node; never a list ("apply, read_board, find" = 3 nodes or 1 group).
   Put detail in a separate `text` node, not in a label.
6. After each write, read `quality`. If `score` < 100, follow `hint` and fix the
   problem before you reply (`layout`, a shorter label, `update_edge` route `elbow`).
7. Never move, change or delete user shapes (`by:user`) unless the user asks.
   `undo` only undoes your own last write.
8. Reply in 1 or 2 lines: what you drew and the quality score. Call `focus` with the
   new ids so the user sees them.

## Rules

- One diagram = one root group or one Mermaid call. Add to an existing diagram with
  `draw_mermaid({parent})` or ops with `parent`.
- Groups (Mermaid `subgraph`) are for real boundaries: process, service, team, layer.
  At most 2 levels deep.
- More than 3 groups: use `flowchart TB` at the root (groups stack, each `direction LR`
  inside). A root `LR` with many groups makes a very wide strip.
- Use roles for meaning: `actor`, `service`, `datastore`, `queue`, `external`, `gap`.
- Pass `baseVersion` from `read_board` to `apply` when the user is active. On a stale
  error, read again and redo the batch.
- Errors name the bad field and the allowed values. Nothing is applied on error.
- `snapshot` returns SVG. Use it only to check the picture; `read_board` is cheaper.
