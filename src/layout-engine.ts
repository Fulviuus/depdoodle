import type { D2, CompileResponse } from "@d2lang/d2";
import { isTauri, invoke } from "@tauri-apps/api/core";

export interface LayoutPoint { x: number; y: number }
export interface LayoutNode extends LayoutPoint { id: string; width: number; height: number }
export interface LayoutEdge { id: string; from: string; to: string }
export interface LayoutGeometry {
  nodes: Map<string, LayoutNode>;
  edges: Map<string, LayoutPoint[]>;
}
export type LayoutMode = "auto" | "fixed";

// Use generated identifiers and empty labels: document text is never executable
// D2 source. DepDoodle measures and places its own labels after routing.
export function buildD2Source(nodes: LayoutNode[], edges: LayoutEdge[], mode: LayoutMode) {
  const nodeIds = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const edgeIds = new Map<string, string>();
  const counts = new Map<string, number>();
  const lines = [
    "vars: { d2-config: { layout-engine: tala; data: { tala-seeds: [1] } } }",
    "direction: right",
  ];
  nodes.forEach(node => {
    const dimensions = `width: ${Math.round(node.width)}; height: ${Math.round(node.height)}`;
    const position = mode === "fixed" ? `; left: ${Math.round(node.x)}; top: ${Math.round(node.y)}` : "";
    lines.push(`${nodeIds.get(node.id)}: \"\" { ${dimensions}${position} }`);
  });
  edges.forEach(edge => {
    const from = nodeIds.get(edge.from), to = nodeIds.get(edge.to);
    if (!from || !to) return;
    const key = `(${from} -> ${to})`;
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    edgeIds.set(`${key}[${index}]`, edge.id);
    lines.push(`${from} -> ${to}: \"\"`);
  });
  return { source: lines.join("\n"), nodeIds, edgeIds };
}

export class D2LayoutEngine {
  constructor(private readonly d2: Pick<D2, "compile" | "dispose">) {}

  async layout(nodes: LayoutNode[], edges: LayoutEdge[], mode: LayoutMode): Promise<LayoutGeometry> {
    if (!nodes.length) return { nodes: new Map(), edges: new Map() };
    const request = buildD2Source(nodes, edges, mode);
    const { diagram } = await this.d2.compile(request.source, { layout: "tala" });
    const shapes = new Map(diagram.shapes.map(shape => [shape.id, shape]));
    const positioned = new Map<string, LayoutNode>();
    const routed = new Map<string, LayoutPoint[]>();
    for (const node of nodes) {
      const shape = shapes.get(request.nodeIds.get(node.id)!);
      if (!shape || !finitePoint(shape.pos)) throw new Error("D2 returned an incomplete layout.");
      if (mode === "fixed" && (shape.pos.x !== Math.round(node.x) || shape.pos.y !== Math.round(node.y))) {
        throw new Error("D2 did not preserve the locked box positions.");
      }
      positioned.set(node.id, { ...node, x: mode === "fixed" ? node.x : shape.pos.x, y: mode === "fixed" ? node.y : shape.pos.y });
    }
    const edgeInputs = new Map(edges.map(edge => [edge.id, edge]));
    for (const connection of diagram.connections) {
      const id = request.edgeIds.get(connection.id);
      if (!id) continue;
      if (!connection.route?.length || !connection.route.every(finitePoint)) throw new Error("D2 returned an invalid connection route.");
      const points = connection.route.map(point => ({ x: point.x, y: point.y }));
      if (mode === "fixed" && points.length >= 2) {
        const edge = edgeInputs.get(id)!;
        const startHorizontal = Math.abs(points[0].y - points[1].y) < 0.001;
        const endHorizontal = Math.abs(points[points.length - 1].y - points[points.length - 2].y) < 0.001;
        restoreFractionalEndpoint(points, positioned.get(edge.from)!, true, startHorizontal);
        restoreFractionalEndpoint(points, positioned.get(edge.to)!, false, endHorizontal);
        // Integer-only D2 coordinates must not quantize the user's box positions.
        if (points.length === 2 && points[0].x !== points[1].x && points[0].y !== points[1].y) {
          const middleX = (points[0].x + points[1].x) / 2;
          points.splice(1, 0, { x: middleX, y: points[0].y }, { x: middleX, y: points[1].y });
        }
      }
      routed.set(id, points);
    }
    if (routed.size !== request.edgeIds.size) throw new Error("D2 did not route every connection.");
    return { nodes: positioned, edges: routed };
  }

  dispose() { return this.d2.dispose(); }
}

function finitePoint(value: unknown): value is LayoutPoint {
  return !!value && typeof value === "object" && "x" in value && "y" in value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function restoreFractionalEndpoint(points: LayoutPoint[], node: LayoutNode, first: boolean, horizontal: boolean) {
  const index = first ? 0 : points.length - 1;
  const neighborIndex = first ? 1 : points.length - 2;
  const point = points[index], neighbor = points[neighborIndex];
  if (horizontal) {
    point.x = point.x < Math.round(node.x) + Math.round(node.width) / 2 ? node.x : node.x + node.width;
    point.y += node.y - Math.round(node.y);
    if (points.length > 2) neighbor.y = point.y;
  } else {
    point.y = point.y < Math.round(node.y) + Math.round(node.height) / 2 ? node.y : node.y + node.height;
    point.x += node.x - Math.round(node.x);
    if (points.length > 2) neighbor.x = point.x;
  }
}

export async function loadLayoutEngine() {
  // Native D2 avoids WebKit's WASM worker stack limit and keeps work off the UI thread.
  if (isTauri()) return new D2LayoutEngine({
    compile: async (source) => {
      try { return await invoke<CompileResponse>("compile_d2", { source }); }
      catch (error) { throw new Error(String(error)); }
    },
    dispose: async () => {},
  });
  const { D2 } = await import("@d2lang/d2");
  return new D2LayoutEngine(new D2());
}
