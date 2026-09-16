# AnimGraph 2 Editor

A standalone editor for Source 2 **AnimGraph 2** (`.vnmgraph`) authored documents.
It runs as a static web page — no build step, no server beyond a file host, no
installer — and edits the same `CNmGraphDocument` that ValveResourceFormat's
decompiler produces.

It does **not** compile. Compiling `.vnmgraph` to `.vnmgraph_c` needs Valve's own
`resourcecompiler` from the game's SDK, and that stays your job.

## The pipeline

```
 .vnmgraph_c   --[ VRF: Decompile ]-->   .vnmgraph   --[ this editor ]-->   .vnmgraph
                                                                                |
                                                          [ Valve resourcecompiler ]
                                                                                v
                                                                         .vnmgraph_c
```

Decompile a graph with ValveResourceFormat (GUI: *Decompile & export*, or
`Decompiler --input <file> --output <dir>`), open the resulting `.vnmgraph` here,
edit it, save, and compile it yourself.

## Running it

```sh
npm run serve      # http://localhost:8173
```

Any static file host works — the page is plain HTML and ES modules. Browsers
refuse to import modules over `file://`, so it does need to be served over HTTP.

Click **Sample** for an example graph, or drag a `.vnmgraph` anywhere onto the
window.

## What it does

- **Canvas** — pan, zoom, select, drag. Nodes are drawn with their pins coloured
  by value type (Pose, Bool, Float, ID, Vector, Target, BoneMask).
- **Wiring** — drag from a pin to another pin. Type mismatches, self-connections
  and cycles are refused with a reason; dragging away from a connected input
  detaches that wire so it can be re-routed.
- **Nested canvases** — double-click a state machine, a state or a virtual
  parameter to go inside it. The breadcrumb walks back out. States expose both
  their blend tree and their layer canvas.
- **Palette** — every node class the catalog knows, grouped and searchable.
- **Inspector** — controls generated from the catalog. A property the catalog
  does not describe is still shown and edited as raw JSON.
- **Layout** — a layered auto-layout, because a decompiled graph carries no
  meaningful canvas coordinates.
- **Problems** — dangling wires, duplicate ids, pin type mismatches, state
  machines with no entry state, unconnected pose inputs.
- **Undo/redo** — everything. A drag or a run of keystrokes is one step.
- **Autosave** — to `localStorage`, restored if the tab dies before a save.

Keyboard: `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo, `Ctrl+S` saves, `Delete`
removes the selection, `F` fits the view, `L` lays the canvas out.

## Round-trip fidelity

The thing that matters for a file you are going to compile is that the editor
does not quietly change anything you did not touch:

- Every node keeps the KV3 object it was parsed from, so properties outside the
  catalog are carried through untouched rather than dropped.
- KV3 floats stay floats. The format distinguishes `0` from `0.0` and the
  compiler cares, so an integral float keeps its `.0`.
- The writer reproduces Valve's own layout — tab indentation, a space either side
  of `=`, trailing commas in arrays, scalar-only arrays on one line.

A load followed by a save with no edits is byte-identical to the input, and a
single rename changes exactly one line. Both are asserted in the tests.

## Where the node catalog comes from

`src/schema/nodes.json` is **generated**, not hand-written. `tools/generate-schema.py`
reads ValveResourceFormat's `NmGraphExtract*.cs` and lifts out every
`CNmGraphDoc*` class the decompiler emits, the pins that class carries, and the
properties it writes — the property type inferred from the accessor each one is
read through. It currently yields 111 classes.

```sh
npm run schema     # re-reads ../ValveResourceFormat sources
```

Re-run it after syncing the fork; the diff shows what Valve or the decompiler
changed. The decompiler is the only complete description of this format outside
Valve's own tools, so restating it by hand would just rot.

## Tests

```sh
npm test                        # KV3, model, schema, layout, round trips
node tests/browser.smoke.mjs    # drives the real UI in Chromium (needs Playwright)
```

The unit tests run the KV3 reader and writer over ValveResourceFormat's own test
corpus, including a full round trip of an authored Valve animation graph. The
browser test loads the page and performs the actual gestures — add a node, drag a
wire onto a pin, drag a node, undo, descend into a sub-graph, lay out, save — and
fails on any console error.

## Layout of the source

| Path | What it is |
| --- | --- |
| `index.html` | The page: toolbar, palette, canvas, inspector, problems |
| `src/kv3/` | KeyValues3 text reader and writer |
| `src/model/document.js` | The `CNmGraphDocument` model: graphs, nodes, pins, wiring rules, validation |
| `src/model/history.js` | Undoable commands |
| `src/model/layout.js` | Layered auto-layout |
| `src/schema/` | The generated node catalog and its accessors |
| `src/editor/` | Canvas rendering and interaction, palette, inspector, app shell |
| `tools/generate-schema.py` | Derives the catalog from the VRF decompiler |
| `tools/serve.mjs` | Static file server for local use |

## Limits

- **No compiling.** By design — see above.
- **No `.vnmgraph_c` reading.** The compiled form is binary KV3 and unpacking it
  is what ValveResourceFormat is for. Decompile first.
- **Nodes whose pin list is built from compiled data** (blend spaces, layer
  blends, selectors) get their fixed pins from the catalog; their variable inputs
  are added with the **+ Pin** button rather than inferred.
- **The catalog is only as complete as the decompiler.** A node class VRF cannot
  yet decompile will not be in the palette, though a document containing one
  still loads, edits and saves without losing it.
