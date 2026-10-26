import { describe, expect, it } from "vitest";
import { DependencyModel, type SemanticNode } from "../src/semantics";
import { RectangleIndex } from "../src/spatial-index";
const edge = (from: string, to: string) => ({ from, to });
describe("dependency semantics", () => {
  it("requires every parent by default, but any parent for OR puzzles", () => {
    const nodes: SemanticNode[] = [{id:"A"},{id:"B"},{id:"All"},{id:"Any",prerequisiteMode:"any"}];
    const model = new DependencyModel(nodes, [edge("A","All"),edge("B","All"),edge("A","Any"),edge("B","Any")]);
    expect(model.available(new Set())).toEqual(["A","B"]);
    expect(model.available(new Set(["A"]))).toEqual(["B","Any"]);
    expect(model.available(new Set(["A","B"]))).toEqual(["All","Any"]);
  });
  it("invalidates downstream completions when a prerequisite is undone", () => {
    const model = new DependencyModel([{id:"A"},{id:"B"},{id:"C"}], [edge("A","B"),edge("B","C")]);
    expect([...model.validCompleted(new Set(["B","C"]))]).toEqual([]);
  });
  it("preserves OR completions while an alternative remains solved", () => {
    const model = new DependencyModel([{id:"A"},{id:"B"},{id:"C",prerequisiteMode:"any"}], [edge("A","C"),edge("B","C")]);
    expect([...model.validCompleted(new Set(["B","C"]))]).toEqual(["B","C"]);
  });
  it("computes only shared narrative ancestors across alternatives", () => {
    const model = new DependencyModel([{id:"Start"},{id:"A"},{id:"B"},{id:"Gate",prerequisiteMode:"any"}], [edge("Start","A"),edge("Start","B"),edge("A","Gate"),edge("B","Gate")]);
    expect([...model.guaranteedAncestors("Gate")]).toEqual(["Start"]);
  });
  it("combines narrative ancestors across mandatory branches", () => {
    const model = new DependencyModel([{id:"A"},{id:"B"},{id:"Gate"}], [edge("A","Gate"),edge("B","Gate")]);
    expect(model.guaranteedAncestors("Gate")).toEqual(new Set(["A","B"]));
  });
  it("finds exact cycle members without including downstream puzzles", () => {
    const model = new DependencyModel([{id:"A"},{id:"B"},{id:"C"},{id:"D"}], [edge("A","B"),edge("B","A"),edge("B","C"),edge("D","D")]);
    expect(model.cycleNodes()).toEqual(new Set(["A","B","D"]));
    expect([...model.guaranteedAncestors("C")]).toEqual([]);
    expect(model.related("A","downstream")).toEqual(new Set(["B","C"]));
  });
  it("distinguishes missing narrative references from unguaranteed references", () => {
    const model = new DependencyModel([{id:"A"},{id:"B",narrativeReferences:["A","gone"]}], []);
    expect(model.narrativeIssues()).toEqual([{nodeId:"B",referenceId:"A",missing:false},{nodeId:"B",referenceId:"gone",missing:true}]);
  });
  it("walks a long chain without recursive stack overflow", () => {
    const nodes = Array.from({length:10000}, (_,i)=>({id:String(i)}));
    const model = new DependencyModel(nodes, nodes.slice(1).map((node,i)=>edge(String(i),node.id)));
    expect(model.cycleNodes().size).toBe(0);
    expect(model.guaranteedAncestors("9999").size).toBe(9999);
  });
});
describe("route obstacle index", () => {
  it("returns overlapping obstacles once and excludes distant obstacles", () => {
    const index = new RectangleIndex<{rect:{left:number;right:number;top:number;bottom:number}}>(10);
    const near = {rect:{left:-5,right:15,top:-5,bottom:15}};
    index.add(near); index.add({rect:{left:100,right:200,top:100,bottom:200}});
    expect(index.query({left:0,right:10,top:0,bottom:10})).toEqual([near]);
  });
  it("handles very long routes without allocating an unbounded grid", () => {
    const index = new RectangleIndex<{rect:{left:number;right:number;top:number;bottom:number}}>();
    const huge = {rect:{left:-1e9,right:1e9,top:-1e9,bottom:1e9}};
    index.add(huge);
    expect(index.query({left:0,right:1,top:0,bottom:1})).toEqual([huge]);
    expect(index.query(huge.rect)).toEqual([huge]);
  });
});
