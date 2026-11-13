# Matrix (2x2)

Use for: impact vs effort, strategy maps, any two-axis placement.

Structure:
- Four groups, one per quadrant, `layout: "grid"`. Group text names the quadrant
  with both axis values, e.g. "High impact · Low effort".
- Root `layout: "grid"` so the four quadrants form a 2x2, in this order:
  top-left, top-right, bottom-left, bottom-right.
- Items are `rect` nodes (or stickies) inside a quadrant. No edges.
- Do not add other top-level nodes: the root grid would no longer be 2x2.
- Use ops, not Mermaid.

Example (ops for `apply`):

```json
[
  {"op":"set_layout","group":"root","layout":"grid"},
  {"op":"add_node","ref":"q1","kind":"group","text":"High impact · Low effort","layout":"grid"},
  {"op":"add_node","ref":"q2","kind":"group","text":"High impact · High effort","layout":"grid"},
  {"op":"add_node","ref":"q3","kind":"group","text":"Low impact · Low effort","layout":"grid"},
  {"op":"add_node","ref":"q4","kind":"group","text":"Low impact · High effort","layout":"grid"},
  {"op":"add_node","text":"Undo","parent":"q1"},
  {"op":"add_node","text":"Offline mode","parent":"q2"}
]
```

Common mistakes:
- Placing items by x/y. Put them in a quadrant group instead.
- Quadrant names without both axis values.
- Guessing a placement the user did not give: ask, or mark the item `?`.
