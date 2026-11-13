# Stickies (clustering)

Use for: sorting notes, retros, brainstorm clusters, "group these by theme".

Structure:
- One group per theme with `layout: "grid"`. Group text = theme name (1 to 3 words).
- Each note is `kind: "sticky"`. Keep the user's words; shorten only very long ones.
- No edges. Root `layout: "dag-tb"` puts the theme groups side by side.
- Use ops, not Mermaid.

Example (ops for `apply`):

```json
[
  {"op":"add_node","ref":"g1","kind":"group","text":"Went well","layout":"grid"},
  {"op":"add_node","ref":"g2","kind":"group","text":"Went badly","layout":"grid"},
  {"op":"add_node","kind":"sticky","text":"CI was fast","parent":"g1"},
  {"op":"add_node","kind":"sticky","text":"Two outages","parent":"g2"},
  {"op":"set_layout","group":"root","layout":"dag-tb"}
]
```

To re-sort user stickies, move them with `update` + `parent` only when the user asks.

Common mistakes:
- A theme with one note: merge it or use "Other".
- Rewriting the user's notes.
- More than 7 themes.
