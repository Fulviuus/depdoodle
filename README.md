# DepDoodle

![DepDoodle logo](public/depdoodle-logo.png)

DepDoodle is a Tauri desktop tool for building puzzle dependency charts. It aims
for an OmniGraffle-like editing surface, but with puzzle-chart semantics built
in: dependency tokens, gates, rewards, graph checks, and automatic path routing.

Project files use the `.depdoodle` extension. The contents are versioned JSON:
easy to diff, easy to recover, and still distinct when searching folders.

## Run

```bash
npm install
npm run tauri dev
```

For browser-only frontend work:

```bash
npm run dev
```

## Current Slice

- Draggable puzzle, gate, and reward nodes.
- Directed dependency arrows with automatic orthogonal rerouting.
- Node and edge inspector.
- Add-node and connect modes.
- Topological auto-layout by dependency layer.
- Structural checks for cycles, dangling leaves, broad layers, roots, and
  branch closers.

## Reference

See [PUZZLE_DEPENDENCY_CHART.md](./PUZZLE_DEPENDENCY_CHART.md) for design notes
from Ron Gilbert's puzzle dependency chart article and Joshua Weinberg's graph
primer.
