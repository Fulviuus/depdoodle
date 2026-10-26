/** Dependency semantics shared by analysis, simulation and narrative checks. */
export interface SemanticNode {
  id: string;
  prerequisiteMode?: "all" | "any";
  narrativeReferences?: string[];
}
export interface SemanticEdge { from: string; to: string }

export class DependencyModel {
  readonly byId: Map<string, SemanticNode>;
  readonly parents = new Map<string, string[]>();
  readonly children = new Map<string, string[]>();
  private cachedCycles: Set<string> | null = null;
  private guaranteedCache = new Map<string, Set<string>>();
  constructor(readonly nodes: SemanticNode[], edges: SemanticEdge[]) {
    this.byId = new Map(nodes.map(node => [node.id, node]));
    nodes.forEach(node => { this.parents.set(node.id, []); this.children.set(node.id, []); });
    edges.forEach(edge => {
      if (!this.byId.has(edge.from) || !this.byId.has(edge.to)) return;
      this.parents.get(edge.to)!.push(edge.from);
      this.children.get(edge.from)!.push(edge.to);
    });
  }

  related(id: string, direction: "upstream" | "downstream"): Set<string> {
    const links = direction === "upstream" ? this.parents : this.children;
    const visited = new Set<string>([id]);
    const stack = [...links.get(id) ?? []];
    while (stack.length) {
      const next = stack.pop()!;
      if (visited.has(next)) continue;
      visited.add(next);
      for (const linked of links.get(next) ?? []) stack.push(linked);
    }
    visited.delete(id);
    return visited;
  }

  /** Strongly connected components: downstream nodes are not labelled cyclic. */
  cycleNodes(): Set<string> {
    if (this.cachedCycles) return this.cachedCycles;
    const seen = new Set<string>();
    const order: string[] = [];
    for (const { id } of this.nodes) {
      if (seen.has(id)) continue;
      const stack: [string, number][] = [[id, 0]];
      seen.add(id);
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const children = this.children.get(frame[0]) ?? [];
        if (frame[1] < children.length) {
          const child = children[frame[1]++];
          if (!seen.has(child)) { seen.add(child); stack.push([child, 0]); }
        } else { order.push(frame[0]); stack.pop(); }
      }
    }
    seen.clear();
    const cyclic = new Set<string>();
    for (const id of order.reverse()) {
      if (seen.has(id)) continue;
      const component = new Set<string>();
      const stack = [id];
      while (stack.length) {
        const next = stack.pop()!;
        if (seen.has(next)) continue;
        seen.add(next); component.add(next);
        for (const parent of this.parents.get(next) ?? []) stack.push(parent);
      }
      if (component.size > 1 || this.children.get(id)?.includes(id)) component.forEach(node => cyclic.add(node));
    }
    this.cachedCycles = cyclic;
    return cyclic;
  }

  canSolve(id: string, solved: ReadonlySet<string>): boolean {
    const parents = this.parents.get(id) ?? [];
    if (!this.byId.has(id)) return false;
    return parents.length === 0 || (this.byId.get(id)?.prerequisiteMode === "any"
      ? parents.some(parent => solved.has(parent)) : parents.every(parent => solved.has(parent)));
  }

  available(solved: ReadonlySet<string>): string[] {
    return this.nodes.filter(node => !solved.has(node.id) && this.canSolve(node.id, solved)).map(node => node.id);
  }

  /** Revalidate completed work after undo or a graph edit, including OR alternatives. */
  validCompleted(requested: ReadonlySet<string>): Set<string> {
    const completed = new Set<string>();
    const seenParents = new Map<string, number>();
    const queued = new Set<string>();
    const queue = this.nodes.filter(node => requested.has(node.id) && !this.parents.get(node.id)?.length).map(node => node.id);
    queue.forEach(id => queued.add(id));
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head];
      completed.add(id);
      for (const child of this.children.get(id) ?? []) {
        const count = (seenParents.get(child) ?? 0) + 1;
        seenParents.set(child, count);
        if (!requested.has(child) || queued.has(child)) continue;
        if (this.byId.get(child)?.prerequisiteMode === "any" || count === this.parents.get(child)?.length) {
          queue.push(child); queued.add(child);
        }
      }
    }
    return completed;
  }

  guaranteedAncestors(id: string): Set<string> {
    const cached = this.guaranteedCache.get(id);
    if (cached) return cached;
    const upstream = this.related(id, "upstream");
    const relevant = new Set([...upstream, id]);
    const cycles = this.cycleNodes();
    // Circular prerequisites provide no reliable narrative guarantee.
    if ([...relevant].some(node => cycles.has(node))) return new Set();
    if (![...relevant].some(node => this.byId.get(node)?.prerequisiteMode === "any")) {
      this.guaranteedCache.set(id, upstream);
      return upstream;
    }
    const pending = new Map([...relevant].map(node => [node, this.parents.get(node)!.length]));
    const queue = [...relevant].filter(node => pending.get(node) === 0);
    const guarantees = new Map<string, Set<string>>();
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      const parents = this.parents.get(current)!;
      const branches = parents.map(parent => new Set([parent, ...guarantees.get(parent) ?? []]));
      const combined = new Set<string>();
      if (this.byId.get(current)?.prerequisiteMode === "any" && branches.length) {
        branches[0].forEach(ancestor => { if (branches.every(branch => branch.has(ancestor))) combined.add(ancestor); });
      } else branches.forEach(branch => branch.forEach(ancestor => combined.add(ancestor)));
      guarantees.set(current, combined);
      for (const child of this.children.get(current) ?? []) {
        if (!relevant.has(child)) continue;
        const remaining = pending.get(child)! - 1;
        pending.set(child, remaining);
        if (!remaining) queue.push(child);
      }
    }
    const result = guarantees.get(id) ?? new Set<string>();
    this.guaranteedCache.set(id, result);
    return result;
  }

  narrativeIssues() {
    return this.nodes.flatMap(node => {
      if (!node.narrativeReferences?.length) return [];
      const guaranteed = this.guaranteedAncestors(node.id);
      return node.narrativeReferences.filter(ref => !guaranteed.has(ref)).map(ref => ({
        nodeId: node.id, referenceId: ref, missing: !this.byId.has(ref),
      }));
    });
  }
}
