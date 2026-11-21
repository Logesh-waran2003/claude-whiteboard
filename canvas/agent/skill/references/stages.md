# Stages (lanes of cards)

Use for: status of projects or tasks, pipelines, "where is everything?", progress.

Structure:
- One root group for the diagram, `layout: "row"`, text = the question it answers
  ("Projects by stage · 4-13 Nov").
- One group per stage, `layout: "column"`, added left to right in stage order
  (Idea -> Building -> Live -> Running). Text = stage name and count ("Live · 3").
- One `card` per item, inside its stage:
  - `text`: title on the first line (4 words or fewer), then 1 or 2 lines of 30
    characters or fewer: the one fact that matters most (goal, blocker, or last
    activity). Put a date in the same line in short form ("12 Nov").
  - `progress`: 0-100 when there is a number. Omit it when there is none.
  - `color`: ONE meaning for the whole diagram (kind of project, or health:
    `4` on track, `2` at risk, `1` blocked). Add a legend text node.
- Order cards in a lane by importance or progress (highest first).
- Links, tech stacks and long notes do NOT go on the board. Mention them in the reply.
- Edges only for real dependencies ("informs", "blocks"), at most a few.

Example (ops for `apply`):

```json
[
  {"op":"add_node","ref":"root","kind":"group","text":"Projects by stage","layout":"row"},
  {"op":"add_node","ref":"legend","kind":"text","text":"Color: blue = own product · orange = client","parent":"root"},
  {"op":"add_node","ref":"s1","kind":"group","text":"Building · 1","layout":"column","parent":"root"},
  {"op":"add_node","ref":"s2","kind":"group","text":"Live · 2","layout":"column","parent":"root"},
  {"op":"add_node","kind":"card","text":"ZedPass\nValidate spec v0.5","progress":30,"color":"5","parent":"s1"},
  {"op":"add_node","kind":"card","text":"ShowTime\nBookings -> WhatsApp","progress":80,"color":"2","parent":"s2"},
  {"op":"add_node","kind":"card","text":"Folio\nTeam + agents share docs","progress":75,"color":"5","parent":"s2"}
]
```

Common mistakes:
- A table: header boxes plus one box per cell. Use one card per item instead.
- Colors with no legend, or two meanings for color.
- Long card text. Move detail to the reply.
