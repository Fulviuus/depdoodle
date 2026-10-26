// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildD2Source, loadLayoutEngine, type D2LayoutEngine, type LayoutNode } from "../src/layout-engine";
let engine: D2LayoutEngine;
beforeAll(async () => { engine = await loadLayoutEngine(); });
afterAll(async () => { await engine.dispose(); });
const nodes: LayoutNode[] = [
  { id: "root", x: 100, y: 100, width: 210, height: 118 },
  { id: "next", x: 600, y: 450, width: 210, height: 118 },
];
const edges = [{ id: "edge", from: "root", to: "next" }];
it("uses real TALA to bend connections around an obstacle while keeping all boxes fixed", async () => {
  const input = [...nodes, { id: "obstacle", x: 400, y: 100, width: 210, height: 118 }];
  const before = structuredClone(input);
  const layout = await engine.layout(input, edges, "fixed");
  expect([...layout.nodes.values()]).toEqual(before);
  expect(input).toEqual(before);
  const path = layout.edges.get("edge")!;
  expect(path.length).toBeGreaterThan(2);
  for (let i = 1; i < path.length; i++) {
    const a = path[i-1], b = path[i];
    expect(a.x === b.x || a.y === b.y).toBe(true);
    if (a.y === b.y && a.y > 100 && a.y < 218) expect(Math.max(a.x,b.x) <= 400 || Math.min(a.x,b.x) >= 610).toBe(true);
    if (a.x === b.x && a.x > 400 && a.x < 610) expect(Math.max(a.y,b.y) <= 100 || Math.min(a.y,b.y) >= 218).toBe(true);
  }
});
it("preserves fractional box positions and attaches orthogonal connectors to their exact edges", async () => {
  const input = nodes.map(node => ({ ...node, x: node.x + 0.25, y: node.y + 0.75, width: node.width + 0.2 }));
  const layout = await engine.layout(input, edges, "fixed");
  expect([...layout.nodes.values()]).toEqual(input);
  const path = layout.edges.get("edge")!;
  expect(path[0].x === input[0].x + input[0].width || path[0].y === input[0].y + input[0].height).toBe(true);
  for (let i=1; i<path.length; i++) expect(path[i].x === path[i-1].x || path[i].y === path[i-1].y).toBe(true);
});
it("maps parallel, reversed and self connections back to their original IDs", async () => {
  const inputEdges = [...edges, { ...edges[0], id: "parallel" }, { id: "reverse", from: "next", to: "root" }, { id: "loop", from: "root", to: "root" }];
  const layout = await engine.layout(nodes, inputEdges, "fixed");
  expect([...layout.edges.keys()].sort()).toEqual(inputEdges.map(edge => edge.id).sort());
  expect(layout.edges.get("loop")!.length).toBeGreaterThan(2);
});
it("only omits position locks for an explicit box layout", async () => {
  const layout = await engine.layout(nodes, edges, "auto");
  expect([...layout.nodes.values()].some((node,i) => node.x !== nodes[i].x || node.y !== nodes[i].y)).toBe(true);
  expect(buildD2Source(nodes,edges,"fixed").source).toContain("left: 100; top: 100");
  expect(buildD2Source(nodes,edges,"auto").source).not.toContain("left:");
});
it("does not interpolate document IDs or text into D2 syntax", () => {
  const injected = 'x: { top: 0 }; $(something)';
  expect(buildD2Source([{...nodes[0],id:injected}], [{id:injected,from:injected,to:injected}], "fixed").source).not.toContain(injected);
});
