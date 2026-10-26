# DepDoodle

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/depdoodle-logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="public/depdoodle-logo.svg" />
    <img src="public/depdoodle-logo.svg" alt="DepDoodle" width="560" />
  </picture>
</p>

DepDoodle is a Tauri desktop editor for puzzle dependency charts. It is built
for adventure-game puzzle design: showing what must be solved before what,
where branches open, where they collapse, what the player can work on at once,
and which narrative assumptions are safe.

The app aims for an OmniGraffle-like charting surface, but with puzzle-chart
semantics built in: dependency tokens, puzzle/gate/reward nodes, structural
checks, visible groups, D2/TALA routing, and a pacing view generated
from the dependency graph.

[Download the latest release](https://github.com/Fulviuus/depdoodle/releases/latest)
for Windows, macOS, or Linux.

## New in 0.3.0

- Keep chapters in separate graph tabs within one project. Drag tabs to reorder
  them and edit each tab's name and description in its inspector.
- Link elements across tabs with movable reference cards and dashed connectors.
  Each end remembers its own position; click a card to visit the other tab.
- Click the centered project title to edit project details separately from the
  active tab. New projects start as **Untitled Project**.
- Resize nodes with four corner handles, with live connector updates, grid
  snapping, keyboard adjustments, undo/redo, and Escape to cancel.
- New nodes and their placement previews use grid-aligned 216 × 120 dimensions.
- Confirmed Auto Layout arranges nodes and reference cards together to avoid
  overlaps. Checks and playthrough simulation remain local to each tab.
- Version 1 files still open with their existing geometry. Saving writes format
  version 2, which requires DepDoodle 0.3.0 or later.

## Screenshots

### Welcome

![DepDoodle welcome screen](docs/screenshots/welcome.png)

### Chart Editor

![DepDoodle chart editor](docs/screenshots/chart.png)

### Pacing View

![DepDoodle pacing view](docs/screenshots/pacing.png)

The screenshots use a small sample chart created only for documentation. The
sample graph is not bundled as an app project.

## What It Edits

A puzzle dependency chart is a directed graph:

- A node is a puzzle, gate, reward, action, or meaningful task.
- An edge is a dependency: if `A -> B`, then `B` requires `A`.
- An edge label is the dependency token: an item, access, fact, state change, or
  permission.
- Roots are immediately available puzzle work.
- Leaves are endpoints, rewards, optional loose ends, or suspicious dangling
  puzzle work.
- Bottlenecks or closers are places where multiple branches collapse.
- A healthy adventure chart often expands into parallel work and contracts into
  milestones.

The longer design memo lives in
[PUZZLE_DEPENDENCY_CHART.md](PUZZLE_DEPENDENCY_CHART.md).

## Core Features

- **Graph tabs**: keep chapters or other sections in separate graphs within one
  project file. Create, reorder, rename, and delete tabs; undo also restores deleted tabs.
- **Cross-tab references**: link a puzzle to an element in another tab. Dashed
  connectors and labeled “other tab” cards show where the reference leads;
  click a card to jump there. References are visible from either end.
- **Welcome screen**: create a new project, open a `.depdoodle` file, or reopen a
  recent graph.
- **Project and tab details**: click the centered project title to edit the
  project name and description. Select a tab to edit that tab's name and description.
- **Puzzle nodes**: create and edit puzzle, gate, and reward nodes. Select a node
  and drag any corner handle to resize it; connectors follow automatically.
  Resizing respects grid snapping, supports undo/redo, and can be canceled with Escape.
- **Node details**: title, memo, optional difficulty, kind, color, incoming
  count, outgoing count, role, prerequisites, unlocks, and safe narrative
  context.
- **Dependency arrows**: connect nodes with directed arrows and label each edge
  with a dependency token.
- **Token types**: item, access, fact, state, and permission.
- **Groups**: create visible groups from selected nodes, name them, color them,
  drag them, hide/show them, ungroup them, or delete their contents with
  confirmation.
- **Pacing tab**: a Gantt-like availability view generated from dependency
  layers, with groups as lanes.
- **Structural checks**: cycles, missing roots, non-reward leaves, over-wide
  layers, missing closers, and routing errors. Toggle multiple checks to glow
  their matching elements and fade the rest to 20% opacity; deselect them to
  restore the normal chart.
- **Branch width chart**: quick view of how many nodes sit in each dependency
  layer.
- **Auto Layout**: D2/TALA arranges nodes and cross-tab reference cards together
  to prevent overlaps, with explicit confirmation before moving them and
  replacing connector routes and labels.
- **Routing**: automatic D2/TALA connection routing on load and after
  graph edits, including live previews while dragging boxes. The preview and
  release use the same router; manual connector and label overrides are preserved.
  Routing keeps every node at its saved position. Inspecting checks or switching views does not
  rearrange boxes or recalculate connection routes.
- **Zoom controls**: zoom in, zoom out, reset, and fit chart to view.
- **Snap to grid**: optional grid snapping for node placement, resizing, group
  movement, and reference cards. New nodes are sized to match the grid.
- **Multiple selection**: box-select or modifier-select nodes, then drag or
  group them.
- **Undo/redo**: multi-step history for graph edits.
- **Search and checks**: jump to and highlight matching puzzles without hiding
  the rest of the chart or changing its zoom and layout.
- **Explicit focus**: use Focus prerequisites or Focus unlocks to isolate a
  subgraph. A visible banner identifies the focused view and restores the entire
  graph with one click.
- **Playthrough simulation**: solve puzzles directly on the chart. Completed
  puzzles get an X, moving dashes lead to accessible next steps, and locked
  puzzles and connections fade to 20% opacity. Undo completion or reset the
  playthrough without editing the chart.
- **Prerequisite rules**: require all incoming dependencies (AND, the default),
  or any incoming dependency (OR) for alternative solutions.
- **Narrative references**: tag events assumed by a puzzle's writing. Checks flag
  missing references and events that are not guaranteed by its prerequisites.
- **Recovery drafts**: edits are saved locally for recovery, with explicit
  Save/Discard/Cancel prompts before leaving an edited graph.
- **Themes**: light and dark mode.
- **Save**: writes a `.depdoodle` project file.
- **Export**: PNG, JPG, PDF, and SVG.

## Main Views

### Graph Tabs

The tab bar above the workspace separates graphs within a project. Use **+** to
add a graph. Drag tabs to reorder them, or use **Alt + Left/Right** with a tab
focused. Selecting a tab opens its inspector, with separate
**Tab name** and **Tab description** fields. **Delete tab…**
asks for confirmation and can be undone. Save writes every tab to the same
`.depdoodle` file. Switching tabs keeps their zoom, selection, search, and
playthrough state for the current session.

The project name is centered above the graph and starts as **Untitled Project**.
Click it to open the dedicated project inspector, where you can edit the project
name and description. Project details are separate from tab details.

To connect chapters, select a puzzle and use **Other tabs** in the inspector.
Choose an element, optionally add a label, and click **Add reference**. Each end
shows a dashed connector to a card naming the other tab and puzzle. Click that
card, or its inspector link, to visit the target. Drag a reference card to
reposition it; its connector follows automatically. Each end keeps its own
position, saved with the project. Reference labels can be edited and links
removed from either end.

Checks, dependency layers, and playthrough simulation operate
only on the active tab's own nodes and dependency arrows. Cross-tab references
are navigation links; they do not add prerequisites or create cycles between
chapters. Deleting a tab or node also removes its incident references, and undo
restores them.

Auto Layout includes the active tab's reference cards as visual endpoints, so
nodes and cards do not overlap. It saves each card's new position on that tab;
the other end in another tab stays where it was. Undo restores the entire layout.

### Welcome

The welcome screen is the project entry point. It shows the product logo,
creates new projects, opens existing `.depdoodle` files, and lists recent files.
Recent items can be removed individually or cleared as a group.

Recent entries are stored locally. In the desktop app, reopening a recent file
reads its current contents from disk. If access has expired or the file moved,
locate the file again. Browser-only recents retain a snapshot because browsers do
not provide persistent filesystem access.

Save important work as a `.depdoodle` file. Unsaved edits also create a local
recovery draft; after an interrupted session, choose **Recover unsaved draft** on
the welcome screen. A successful save or explicit discard clears that draft.
Recovery depends on local storage being available and is not a backup of the
project file.

### Chart

The Chart tab is the editable dependency canvas. It contains:

- left analysis sidebar
- central graph canvas
- right inspector
- toolbar for save, export, undo, redo, tools, layout, snap, zoom, fit, and
  theme

Connection routing runs automatically, including for older files that do not
store bend points. While dragging, connections follow the boxes and D2 refines
their routes in the background; releasing keeps the latest route for the final
position. **Auto Layout** is the only operation that
rearranges boxes, and it always requires explicit confirmation. Saved manual
connection and label overrides take precedence over automatic routing.

Use **Node** to place puzzle nodes. Use **Connect** to click one node and then
another, creating a dependency. Use **Select** to move nodes, select groups, drag
routes, or edit labels.

Selected nodes have four corner handles. Drag a handle to resize the node while
keeping the opposite corner fixed; connected arrows update as you drag. With a
handle focused, use the arrow keys to resize by a grid step, or by one pixel
when snapping is off (**Shift** uses ten pixels). Press **Escape** during a drag
to cancel it. Resizing is saved with the project and supports undo/redo.

New nodes and their placement previews are 216 × 120, a whole number of grid
cells. Existing nodes retain their saved sizes.

### Pacing

The Pacing tab turns the dependency graph into an availability timeline:

- columns are topological dependency layers
- lanes are visible groups
- bars show when puzzle work becomes available and how far it influences later
  work
- closers, critical path length, loose leaves, and broad layers are summarized

Puzzles with an OR prerequisite use their earliest alternative dependency layer.
Their safe narrative context contains only ancestors shared by every alternative.
Cycles remain visible as structural warnings; the critical path is suppressed
until the cycle is resolved.

This is deliberately not a calendar Gantt chart. It does not guess real time or
task duration. It is a puzzle-availability chart: useful for spotting linear
stretches, over-broad layers, act gates, and pacing pressure.

### Checks and Playthrough

Click a check in the analysis sidebar to highlight its nodes and connections.
Click additional checks to combine their highlights, or click a selected check
again to remove it. Checks do not move boxes or edit the project.

Enable **Simulate playthrough** in the sidebar, then use **Solve** on an available
puzzle. Completed puzzles show an X, and moving dashes point to newly available
work. Inaccessible elements are 80% transparent. Use **Undo** to reverse a
completion or **Reset playthrough** to start again. Undoing a prerequisite also
clears completions that are no longer reachable.

Simulation follows each puzzle's AND/OR prerequisite rule and is also visible
in the Pacing tab. It does not change the saved project. Disabling simulation
restores the normal chart; enabling it again resumes the current playthrough.

## Inspector Behavior

The inspector edits whatever is selected:

- **Project title selected**: project name, project description, file name, and project contents.
- **Nothing selected / tab selected**: tab name, tab description, and tab contents.
- **One node selected**: node semantics and relationships.
- **Multiple nodes selected**: selection summary, create group, or delete nodes.
- **Group selected**: group name, color, visibility, ungroup, or delete group
  contents.
- **Edge selected**: dependency token label, token type, route reset, label
  reset, or delete edge.

This is intentional: semantic data should be visible and editable. The app
should not rely on hidden chart meaning.

## File Format

DepDoodle projects use the `.depdoodle` extension. The contents are versioned
JSON so they are easy to inspect, diff, recover, and transform.

Current format (version 2):

```json
{
  "format": "depdoodle.graph",
  "version": 2,
  "title": "An adventure",
  "description": "Project notes.",
  "tabs": [
    {
      "id": "chapter-1",
      "name": "Chapter 1",
      "description": "The arrival chapter.",
      "world": { "width": 1680, "height": 1040 },
      "nodes": [],
      "edges": [],
      "groups": [],
      "references": []
    }
  ]
}
```

Each tab owns its nodes, edges, groups, and canvas dimensions. Node IDs need to
be unique only within their tab. A cross-tab reference is stored on its source
tab with `id`, `from`, `toTabId`, `toNodeId`, and `label` fields. `from` is a local
node ID; the destination identifies a node in another tab. Optional
`sourcePosition` and `targetPosition` coordinates preserve each reference card’s
placement in its respective tab.

Version 1 projects open as a single tab without moving their boxes or changing
manual connection routes. Saving uses version 2, which requires DepDoodle 0.3.0
or later; version 0.2.x cannot open the new project format.

### Node Fields

Each node stores:

- `id`
- `title`
- `note`
- `kind`: `puzzle`, `gate`, or `reward`
- `color`
- optional `difficulty`
- `prerequisiteMode`: `all` (default) or `any`
- `narrativeReferences`: IDs of events assumed by the node's writing
- `x`, `y`, `width`, `height`

### Edge Fields

Each dependency edge stores:

- `id`
- `from`
- `to`
- `label`
- `tokenType`: `item`, `access`, `fact`, `state`, or `permission`
- optional `manualRoute`: saved connector waypoints, whether drawn by hand or
  accepted from an explicitly confirmed routing action
- optional `manualLabelPosition`: saved label position along the connector

### Group Fields

Each visible group stores:

- `id`
- `name`
- `color`
- `nodeIds`
- `hidden`

Groups are the only semantic lane/thread system used by the Pacing tab. If a
node is not in a group, it appears in an **Ungrouped** lane.

### Legacy Data

Older project files may contain a hidden node field called `act`. The current
app does not use hidden `act` data. On load, legacy `act` values are converted
into visible groups. A legacy `Beginning / Ending` act is split into separate
`Beginning` and `Ending` groups.

When saved again, the project uses visible groups and no hidden `act` fields.

## Export

DepDoodle exports the active tab, including its cross-tab reference cards, as:

- PNG
- JPG
- PDF
- SVG

Raster exports use a higher internal scale for better quality. SVG export is the
best choice when the chart needs to stay editable or scale cleanly in other
tools.

## Architecture

DepDoodle is intentionally small:

- **Tauri 2** for the desktop shell.
- **Vite** for frontend development.
- **TypeScript** for app logic.
- **Vanilla DOM/CSS** for the UI.
- **D2/TALA** for graph layout and routing: a bundled native helper on desktop,
  and `@d2lang/d2` in a background worker for the browser frontend.
- **Lucide** for toolbar and UI icons.

Important paths:

- [src/layout-engine.ts](src/layout-engine.ts): D2/TALA adapter with fixed-position routing.
- [src-d2](src-d2): bundled native D2 helper.
- [scripts/build-d2.mjs](scripts/build-d2.mjs): platform-specific helper build.
- [src/main.ts](src/main.ts): app state, graph editing, rendering, routing,
  import/export, analysis, and inspector logic.
- [src/styles.css](src/styles.css): Material-style UI, canvas, nodes, groups,
  edges, welcome screen, and pacing view.
- [src/semantics.ts](src/semantics.ts): prerequisite rules, simulation, cycles,
  and guaranteed narrative context.
- [src/spatial-index.ts](src/spatial-index.ts): route-label collision queries.
- [src-tauri](src-tauri): Tauri desktop configuration and Rust shell.
- [public/depdoodle-logo.svg](public/depdoodle-logo.svg): vector product logo,
  with a [dark version](public/depdoodle-logo-dark.svg),
  [standalone mark](public/depdoodle-mark.svg), and
  [app icon source](public/depdoodle-icon.svg).
- [docs/screenshots](docs/screenshots): README screenshots.
- [PUZZLE_DEPENDENCY_CHART.md](PUZZLE_DEPENDENCY_CHART.md): puzzle dependency
  chart design memo.

## Releases

Release builds are published on
[GitHub Releases](https://github.com/Fulviuus/depdoodle/releases) for Windows,
macOS (Apple Silicon and Intel), and Linux.

Download the installer or package for your platform from the release assets.
Packaged builds include the D2 engine; no additional layout software is needed.

The macOS builds are ad-hoc signed but not notarized. On first launch, macOS may
block the app until it is allowed from **System Settings > Privacy & Security**.

## Development

Desktop builds require Node.js, the Tauri/Rust toolchain, and Go 1.27+ for the
bundled D2 helper. Users of packaged builds do not need Go or D2 installed.
The helper is built automatically by `tauri dev` and `tauri build`.

Install dependencies:

```bash
npm ci
```

Run the desktop app:

```bash
npm run tauri dev
```

Run the browser-only frontend:

```bash
npm run dev
```

Build the frontend:

```bash
npm run build
```

Run the frontend regression suite (Node.js 20, 22, or 24+):

```bash
npm test
```

Test the native D2 helper:

```bash
cd src-d2
go test ./...
```

D2 0.9.0 is bundled under [MPL-2.0](https://github.com/d2lang/d2/blob/v0.9.0/LICENSE.txt).
Its license and third-party notices are included in desktop builds; source is
available at [d2lang/d2](https://github.com/d2lang/d2/tree/v0.9.0).
The native helper avoids a WebKit WebAssembly worker stack limit. The browser
frontend uses the WASM package and requires a compatible browser.

The tests cover real D2 routing, fixed box positions, drag previews, resizing,
check highlighting, graph tabs, cross-tab references, layout collisions, cycles,
unsaved changes, recovery, native save/open behavior, exports, simulation,
prerequisite rules, narrative references, and focus views.

Create a production Tauri build:

```bash
npm run tauri build
```

## Design Principles

- Prefer visible semantics over hidden metadata.
- Keep graph data recoverable and human-readable.
- Use groups for lanes, acts, characters, locations, chapters, or puzzle
  threads.
- Use D2/TALA for confirmed box layout and automatic connection routing; lock
  every box during connection-only routing.
- Keep manual layout overrides explicit and saved.
- Treat the dependency chart as design structure, not a walkthrough.
- Use analysis to reveal risks, not to dictate one correct design.

## Current Limitations

- Recovery drafts are local; use Save to update the `.depdoodle` project file.
- The app does not currently import GraphML directly from the UI.
- Pacing bars are generated from dependency layers, not real time estimates.
- Narrative checking validates explicit event references; it does not infer
  references from the prose of a memo.
- The file format is versioned but still early.

## License

DepDoodle is licensed under the GNU General Public License v3.0. See
[LICENSE](LICENSE).

## Reference Material

The project is based on the puzzle dependency chart workflow described by Ron
Gilbert and expanded through graph-analysis language by Joshua Weinberg. See the
local memo for project-specific notes:

[PUZZLE_DEPENDENCY_CHART.md](PUZZLE_DEPENDENCY_CHART.md)
