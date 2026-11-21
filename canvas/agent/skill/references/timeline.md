# Timeline

Use for: plans, history, "where did the time go?", anything with dates.

Structure (all numbers keep 48 px between shapes, so the engine does not move them):
- One root group, `layout: "free"`, at `x: GX, y: GY`, text = the period
  ("Work · 2-12 Nov").
- Pick a scale: `D` px per day (40 for 2 weeks, 12 for 3 months). Day `d`
  (0 = first day) is at `X0 + d * D`, where `X0 = GX + 256`.
- One row per item. Row `i` top: `GY + 160 + i * 120`.
- Per row, give x, y, width and height (the engine keeps them):
  - Label: `kind: "text"`, x = `GX + 40`, width 160, height 64, text = item name.
  - Bar: `kind: "rect"`, x = `X0 + start * D`, width = `max(64, days * D)`,
    height 64, `color` = one meaning (kind or health), text = the result in 1-3
    words or the percent ("70%"). A one-day event is a 64 px wide box.
- Date marks: `kind: "text"`, y = `GY + 72`, width 96, height 40, text = the date
  ("6 Nov"). Space them 144 px or more apart (every `ceil(144 / D)` days).
- Legend: say what the color means in the reply, or add a text node below the rows.

Example (D = 40, group at 0,0, so X0 = 256):

```json
[
  {"op":"add_node","ref":"tl","kind":"group","text":"Work · 2-12 Nov","layout":"free","x":0,"y":0},
  {"op":"add_node","kind":"text","text":"2 Nov","parent":"tl","x":256,"y":72,"width":96,"height":40},
  {"op":"add_node","kind":"text","text":"6 Nov","parent":"tl","x":416,"y":72,"width":96,"height":40},
  {"op":"add_node","kind":"text","text":"AI Reels","parent":"tl","x":40,"y":160,"width":160,"height":64},
  {"op":"add_node","kind":"rect","text":"15%","color":"6","parent":"tl","x":256,"y":160,"width":200,"height":64},
  {"op":"add_node","kind":"text","text":"Folio","parent":"tl","x":40,"y":280,"width":160,"height":64},
  {"op":"add_node","kind":"rect","text":"75%","color":"5","parent":"tl","x":416,"y":280,"width":80,"height":64}
]
```

Common mistakes:
- Bars without x/width: the engine then stacks them and the time scale is lost.
- Date marks closer than 144 px: show fewer dates.
