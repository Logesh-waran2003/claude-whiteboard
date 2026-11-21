---
name: board
description: Draw on the shared whiteboard (a JSON Canvas file). Use any time the user wants a diagram, map, board, flow, architecture, status overview, timeline, sticky clustering or 2x2 matrix on the shared board.
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
3. Pick the PICTURE from the question, not from the data. A board must be understood
   faster than a paragraph. Load the reference with `get_skill({name})`:

   | The user wants to know | Picture | Reference |
   |---|---|---|
   | Where is each thing? Status, progress, pipeline | Lanes of cards with progress bars | `stages` |
   | What should I do next? Compare on 2 measures | 2x2 map | `matrix` |
   | When? Where did the time go? Plan, history | Timeline | `timeline` |
   | How does it work / connect? | Architecture | `architecture` |
   | What happens in which order? | Flow or sequence | `flow`, `sequence` |
   | What data, which relations? | Entities | `er` |
   | Raw ideas to sort | Sticky clusters | `stickies` |

   Never draw a table of boxes (one box per cell). Put one item in one shape. Show
   meaning with position (lane, quadrant, time), color (one meaning, say it in a
   legend) and progress bars. Text explains; it does not carry the picture.
   Draw a table only when the user asks for a table.
4. Describe a GRAPH, not pixels.
   - New flow or architecture: `draw_mermaid`.
   - Edits (rename, connect, regroup, remove): `apply` with ops.
   - Omit x, y, width and height. The engine places new shapes.
   - Use `find` to get ids before an edit.
5. Keep labels short: a node has 6 words or fewer, an edge label 1 to 3 words.
   A `card` has a title of 4 words or fewer and at most 2 body lines of 30
   characters or fewer each.
   One concept per node; never a list ("apply, read_board, find" = 3 nodes or 1 group).
   Put detail in a separate `text` node, not in a label.
6. After each write, read `quality`. If `score` < 100, follow `hint` and fix the
   problem before you reply (`layout`, a shorter label, `update_edge` route `elbow`).
7. The 5-second test. Call `snapshot` (ids = your root group) and look at the picture
   as the user would. Fix and look again if any answer is "no":
   - Is the main answer visible in 5 seconds, without reading every label?
   - Do position and color mean something, and is there a legend for color?
   - Is each item one shape (no table of cells, no repeated column headers)?
   - Is the most important thing the most visible?
8. Never move, change or delete user shapes (`by:user`) unless the user asks.
   `undo` only undoes your own last write.
9. Reply in 1 or 2 lines: what you drew, what the picture shows (the insight), and
   the quality score. Call `focus` with the
   new ids so the user sees them.

## Rules

- One diagram = one root group or one Mermaid call. Add to an existing diagram with
  `draw_mermaid({parent})` or ops with `parent`.
- Groups (Mermaid `subgraph`) are for real boundaries: process, service, team, layer.
  At most 2 levels deep.
- More than 3 groups: use `flowchart TB` at the root (groups stack, each `direction LR`
  inside). A root `LR` with many groups makes a very wide strip.
- Use roles for meaning: `actor`, `service`, `datastore`, `queue`, `external`, `gap`.
- Colors: `1` red, `2` orange, `3` yellow, `4` green, `5` cyan, `6` purple. Use one
  color scheme per diagram (for example kind, or health) and add a legend text node.
- Pass `baseVersion` from `read_board` to `apply` when the user is active. On a stale
  error, read again and redo the batch.
- Errors name the bad field and the allowed values. Nothing is applied on error.
- `snapshot` returns a PNG picture. Use it for the 5-second test; for structure,
  `read_board` is cheaper.
