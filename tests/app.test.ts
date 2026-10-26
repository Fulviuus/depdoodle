import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ enabled: false, save: vi.fn(), open: vi.fn(), read: vi.fn(), write: vi.fn(), close: vi.fn() }));
const routing = vi.hoisted(() => {
  return { layout: vi.fn(), load: vi.fn() };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn(), close: native.close }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), save: native.save, open: native.open }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: native.read, writeTextFile: native.write, writeFile: vi.fn() }));
vi.mock("@d2lang/d2", () => ({ D2: class { constructor() { routing.load(); } compile = routing.layout; dispose = vi.fn(); } }));
let app: typeof import("../src/main");
const context = { scale: vi.fn(), translate: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), measureText: (s: string) => ({ width: s.length * 7 }), arcTo: vi.fn(), arc: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), fillText: vi.fn(), rect: vi.fn(), clip: vi.fn() };
const node = (id: string, x = 0) => ({ id, title: id, note: "", kind: "puzzle" as const, color: "#549aa3", x, y: 100, width: 210, height: 118 });
const graph = (cyclic = false) => ({ format: "depdoodle.graph" as const, version: 1 as const, title: "Test", nodes: [node("A"), node("B", 300)], edges: [{ id: "ab", from: "A", to: "B", label: "", tokenType: "state" as const }, ...(cyclic ? [{ id: "ba", from: "B", to: "A", label: "", tokenType: "state" as const }] : [])] });
const click = (id: string) => (document.getElementById(id) as HTMLElement).click();
const edit = (id: string, value: string) => { const input = document.getElementById(id) as HTMLInputElement; input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function (value = "") { this.returnValue = value; this.open = false; this.dispatchEvent(new Event("close")); };
  vi.stubGlobal("Path2D", class { });
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(false);
  app = await import("../src/main");
});
beforeEach(async () => {
  routing.load.mockClear(); routing.layout.mockReset(); native.close.mockClear();
  routing.layout.mockImplementation(async (source: string) => {
    const shapes = [...source.matchAll(/^(n\d+): "" \{ width: (\d+); height: (\d+)(?:; left: (-?\d+); top: (-?\d+))? \}/gm)].map((match, i) => ({
      id: match[1], width: Number(match[2]), height: Number(match[3]), pos: { x: Number(match[4] ?? i * 400), y: Number(match[5] ?? 100) },
    }));
    const counts = new Map<string, number>();
    const connections = [...source.matchAll(/^(n\d+) -> (n\d+):/gm)].map(match => {
      const key = `(${match[1]} -> ${match[2]})`, index = counts.get(key) ?? 0; counts.set(key, index + 1);
      const from = shapes.find(shape => shape.id === match[1])!, to = shapes.find(shape => shape.id === match[2])!;
      const x = (from.pos.x + from.width + to.pos.x) / 2;
      return { id: `${key}[${index}]`, route: [{x:from.pos.x+from.width,y:from.pos.y+59},{x,y:from.pos.y+59},{x,y:to.pos.y+100},{x:to.pos.x,y:to.pos.y+100}] };
    });
    return { diagram: { shapes, connections } };
  });
  vi.mocked(window.confirm).mockReset().mockReturnValue(false);
  native.enabled = false; native.save.mockReset(); native.read.mockReset(); native.write.mockReset(); context.translate.mockClear(); context.fillRect.mockClear(); localStorage.clear(); app.openGraphDocument(graph(), "test.depdoodle", false);
  await app.ensureAutomaticRouting();
  routing.load.mockClear(); routing.layout.mockClear();
});
afterEach(async () => { await app.ensureAutomaticRouting(); });
describe("review regressions", () => {
  it("renders cyclic graphs without hanging and suppresses the invalid critical path", () => { app.openGraphDocument(graph(true), "cycle.depdoodle", false); expect(app.analyzeGraph().topology.hasCycle).toBe(true); expect(app.criticalPathForAnalysis(app.analyzeGraph())).toEqual([]); click("view-pacing"); expect(document.querySelector("#pacing-board")?.textContent).toContain("none"); });
  it("keeps unsaved work when leaving is cancelled, and persists a recovery copy", async () => { edit("chart-title", "Draft"); click("back-to-welcome"); expect(document.querySelector("dialog")?.open).toBe(true); expect(JSON.parse(localStorage.getItem("depdoodle.recovery")!).document.title).toBe("Draft"); document.querySelector("dialog")!.close("cancel"); await Promise.resolve(); expect(document.querySelector("#workbench")?.hasAttribute("hidden")).toBe(false); expect(app.createGraphDocument().title).toBe("Draft"); });
  it("leaves after explicit discard", async () => { edit("chart-title", "Discard"); click("back-to-welcome"); document.querySelector("dialog")!.close("discard"); await vi.waitFor(() => expect(document.querySelector("#workbench")?.hasAttribute("hidden")).toBe(true)); expect(localStorage.getItem("depdoodle.recovery")).toBeNull(); });
  it("requests a destination again if a remembered path has lost its scope", async () => { native.enabled = true; app.openGraphDocument(graph(), "test.depdoodle", false, "/tmp/old.depdoodle"); native.write.mockRejectedValueOnce(new Error("forbidden path")).mockResolvedValueOnce(undefined); native.save.mockResolvedValue("/tmp/new.depdoodle"); expect(await app.saveGraph()).toBe(true); expect(native.save).toHaveBeenCalledOnce(); expect(native.write).toHaveBeenLastCalledWith("/tmp/new.depdoodle", expect.any(String)); });
  it("reopens a recent file from disk rather than from its cached snapshot", async () => { native.enabled = true; native.save.mockResolvedValue("/tmp/recent.depdoodle"); native.write.mockResolvedValue(undefined); await app.saveGraph(); click("back-to-welcome"); await Promise.resolve(); native.read.mockResolvedValue(JSON.stringify({ ...graph(), title: "Changed externally" })); (document.querySelector(".recent-open") as HTMLElement).click(); await vi.waitFor(() => expect(app.createGraphDocument().title).toBe("Changed externally")); expect(native.read).toHaveBeenCalledWith("/tmp/recent.depdoodle"); });
  it("refreshes the visible pacing bar when editing its title", () => { click("view-pacing"); (document.querySelector(".pacing-bar") as HTMLElement).click(); edit("node-title", "New title"); expect(document.querySelector(".pacing-bar")?.textContent).toContain("New title"); });
  it("does not build the hidden pacing board", () => { document.querySelector("#pacing-board")!.innerHTML = ""; app.openGraphDocument(graph(), "test.depdoodle", false); expect(document.querySelector("#pacing-board")!.innerHTML).toBe(""); click("view-pacing"); expect(document.querySelector(".pacing-bar")).not.toBeNull(); });
  it("translates before drawing a cropped export background", () => { app.openGraphDocument({ ...graph(), nodes: [node("Offset", 900)], edges: [] }, "test.depdoodle", false); app.renderGraphToCanvas(); expect(context.translate.mock.invocationCallOrder[0]).toBeLessThan(context.fillRect.mock.invocationCallOrder[0]); expect(context.translate.mock.calls[0][0]).toBeLessThan(0); });
});
describe("authoring features", () => {
  it("searches without hiding the chart and isolates only through explicit focus", () => {
    const before = app.createGraphDocument();
    edit("node-search", "B");
    (document.querySelector("[data-search-node='B']") as HTMLElement).click();
    expect(document.querySelectorAll(".node")).toHaveLength(2);
    expect(app.createGraphDocument()).toEqual(before);
    click("focus-downstream");
    expect(document.querySelectorAll(".node")).toHaveLength(1);
    expect(document.getElementById("focus-banner")?.hasAttribute("hidden")).toBe(false);
    click("clear-focus");
    expect(document.querySelectorAll(".node")).toHaveLength(2);
  });
  it("lets a playthrough unlock downstream work without changing graph data", () => {
    const before = app.createGraphDocument();
    const toggle = document.getElementById("simulate-toggle") as HTMLInputElement;
    toggle.checked = true; toggle.dispatchEvent(new Event("change"));
    expect(document.querySelector("[data-solve='A']")).not.toBeNull();
    expect(document.querySelector("[data-solve='B']")).toBeNull();
    (document.querySelector("[data-solve='A']") as HTMLElement).click();
    expect(document.querySelector("[data-solve='B']")).not.toBeNull();
    expect(app.createGraphDocument()).toEqual(before);
    click("reset-simulation");
    expect(document.querySelector("#simulation-panel")?.textContent).toContain("0 solved");
  });
  it("highlights exact cycle members while preserving the full chart", () => {
    const documentGraph = graph(true); documentGraph.nodes.push(node("Downstream", 600));
    documentGraph.edges.push({id:"bc",from:"B",to:"Downstream",label:"",tokenType:"state"});
    app.openGraphDocument(documentGraph,"cycle.depdoodle",false);
    (document.querySelector(".diagnostic") as HTMLElement).click();
    expect(document.querySelectorAll(".node")).toHaveLength(3);
    expect([...document.querySelectorAll<HTMLElement>(".node.selected")].map(element=>element.dataset.nodeId).sort()).toEqual(["A","B"]);
    expect(document.querySelectorAll(".edge-group.selected")).toHaveLength(2);
  });
  it("persists prerequisite rules and narrative references through serialization", () => {
    click("view-pacing"); (document.querySelector("[data-node-id='B'].pacing-bar") as HTMLElement).click();
    const mode = document.getElementById("prerequisite-mode") as HTMLSelectElement;
    mode.value = "any"; mode.dispatchEvent(new Event("change"));
    const ref = document.getElementById("narrative-reference") as HTMLSelectElement;
    ref.value = "A"; ref.dispatchEvent(new Event("change"));
    const saved = app.createGraphDocument();
    expect(saved.nodes.find(node=>node.id==="B")).toMatchObject({prerequisiteMode:"any",narrativeReferences:["A"]});
    app.openGraphDocument(saved,"test.depdoodle",false);
    expect(app.createGraphDocument().nodes.find(node=>node.id==="B")?.narrativeReferences).toEqual(["A"]);
  });
  it("keeps new edits dirty if they happen during a save", async () => {
    native.enabled = true;
    app.openGraphDocument(graph(),"test.depdoodle",false,"/tmp/test.depdoodle");
    let finish!: () => void;
    native.write.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const saving = app.saveGraph();
    edit("chart-title","Edited while saving");
    finish(); await saving;
    expect(document.querySelector("#save-status")?.textContent).toBe("Unsaved changes");
  });
  it("keeps the document open when Save is cancelled in the leave prompt", async () => {
    native.enabled = true; native.save.mockResolvedValue(null);
    edit("chart-title","Keep me"); click("back-to-welcome");
    document.querySelector("dialog")!.close("save");
    await vi.waitFor(()=>expect(native.save).toHaveBeenCalled());
    expect(app.createGraphDocument().title).toBe("Keep me");
    expect(document.querySelector("#workbench")?.hasAttribute("hidden")).toBe(false);
  });
});
describe("recovery and view isolation", () => {
  it("never silently opens the cached snapshot when a recent file is missing", async () => {
    native.enabled = true; native.save.mockResolvedValue("/tmp/missing.depdoodle"); native.write.mockResolvedValue(undefined);
    await app.saveGraph(); click("back-to-welcome"); await Promise.resolve();
    native.read.mockRejectedValue(new Error("missing")); native.open.mockResolvedValue(null);
    (document.querySelector(".recent-open") as HTMLElement).click();
    await vi.waitFor(()=>expect(native.open).toHaveBeenCalled());
    expect(document.getElementById("workbench")?.hasAttribute("hidden")).toBe(true);
  });
  it("does not mark a new graph saved when browser download setup fails", async () => {
    edit("chart-title","Unwritten work");
    const original = URL.createObjectURL;
    URL.createObjectURL = () => {throw new Error("download unavailable");};
    try { expect(await app.saveGraph()).toBe(false); expect(document.getElementById("save-status")?.textContent).toBe("Unsaved changes"); }
    finally { URL.createObjectURL = original; }
  });
  it("uses the earliest alternative layer for an OR prerequisite", () => {
    const base=graph(); base.nodes.push(node("C",600),node("Gate",900));
    base.edges.push({id:"bc",from:"B",to:"C",label:"",tokenType:"state"},{id:"ag",from:"A",to:"Gate",label:"",tokenType:"state"},{id:"cg",from:"C",to:"Gate",label:"",tokenType:"state"});
    app.openGraphDocument({...base,nodes:base.nodes.map(node=>node.id==="Gate"?{...node,prerequisiteMode:"any" as const}:node)},"or.depdoodle",false);
    expect(app.analyzeGraph().topology.layerByNode.get("Gate")).toBe(1);
  });
});
it("keeps node DOM elements while previewing a drag", () => {
  const first=document.querySelector<HTMLElement>(".node[data-node-id='A']")!;
  first.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,button:0,clientX:10,clientY:110}));
  const during=document.querySelector<HTMLElement>(".node[data-node-id='A']")!;
  window.dispatchEvent(new MouseEvent("pointermove",{clientX:200,clientY:200}));
  expect(document.querySelector(".node[data-node-id='A']")).toBe(during);
  expect(during.style.left).not.toBe("0px");
  window.dispatchEvent(new MouseEvent("pointerup"));
});
it("keeps a newly created puzzle visible while a focus view is active", () => {
  edit("node-search","B"); (document.querySelector("[data-search-node='B']") as HTMLElement).click();
  click("focus-downstream");
  click("tool-node");
  document.getElementById("graph-space")!.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,button:0,clientX:200,clientY:200}));
  expect(app.createGraphDocument().nodes).toHaveLength(3);
  expect(document.querySelectorAll(".node")).toHaveLength(2);
});

it("does not change geometry, group bounds, zoom or saved data when inspecting a check", () => {
  const fixture = { ...graph(), nodes: [...graph().nodes, node("Unrelated", 700)], groups: [{ id: "group", name: "Act", color: "#549aa3", hidden: false, nodeIds: ["A", "B", "Unrelated"] }] };
  app.openGraphDocument(fixture, "layout.depdoodle", false);
  click("zoom-out");
  const before = app.createGraphDocument();
  const groupStyle = document.querySelector(".group-box")?.getAttribute("style");
  const edgePath = document.querySelector(".edge-path")?.getAttribute("d");
  const zoom = document.getElementById("zoom-level")?.textContent;
  (Array.from(document.querySelectorAll<HTMLButtonElement>(".diagnostic")).find(button => button.textContent?.includes("B."))!).click();
  expect(document.querySelectorAll(".node")).toHaveLength(3);
  expect(document.querySelector(".group-box")?.getAttribute("style")).toBe(groupStyle);
  expect(document.querySelector(".edge-path")?.getAttribute("d")).toBe(edgePath);
  expect(document.getElementById("zoom-level")?.textContent).toBe(zoom);
  expect(document.getElementById("focus-banner")?.hasAttribute("hidden")).toBe(true);
  expect(app.createGraphDocument()).toEqual(before);
});
it("exits an explicit focus when inspecting a check without changing zoom", () => {
  edit("node-search", "B");
  (document.querySelector("[data-search-node='B']") as HTMLElement).click();
  click("focus-downstream");
  const zoom = document.getElementById("zoom-level")?.textContent;
  expect(document.querySelectorAll(".node")).toHaveLength(1);
  (document.querySelector(".diagnostic") as HTMLElement).click();
  expect(document.querySelectorAll(".node")).toHaveLength(2);
  expect(document.getElementById("zoom-level")?.textContent).toBe(zoom);
  expect(document.getElementById("focus-banner")?.hasAttribute("hidden")).toBe(true);
});

describe("connection routing and confirmed box layout", () => {
  it("preserves manual connector overrides through opening, checks, labels, dragging and export", () => {
    const route = [{x:210,y:150},{x:245,y:150},{x:245,y:240},{x:300,y:240}];
    app.openGraphDocument({...graph(),edges:[{...graph().edges[0],manualRoute:route,manualLabelPosition:0.4}]},"routed.depdoodle",false);
    (document.querySelector(".diagnostic") as HTMLElement).click();
    click("view-pacing"); click("view-chart");
    (document.querySelector(".edge-hit") as Element).dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:245,clientY:150}));
    window.dispatchEvent(new MouseEvent("pointerup"));
    edit("edge-label","New token");
    const first=document.querySelector<HTMLElement>(".node[data-node-id='A']")!;
    first.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:10,clientY:110}));
    window.dispatchEvent(new MouseEvent("pointermove",{clientX:40,clientY:140}));
    window.dispatchEvent(new MouseEvent("pointerup"));
    app.renderGraphToCanvas();
    expect(routing.load).not.toHaveBeenCalled();
    expect(routing.layout).not.toHaveBeenCalled();
    expect(app.createGraphDocument().edges[0].manualRoute).toEqual(route);
  });
  it("does nothing when rerouting is declined", () => {
    const before=app.createGraphDocument(); click("reroute-graph");
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(routing.layout).not.toHaveBeenCalled();
    expect(app.createGraphDocument()).toEqual(before);
  });
  it("saves confirmed routes and can undo them", async () => {
    const before=app.createGraphDocument();
    vi.mocked(window.confirm).mockReturnValue(true); click("reroute-graph");
    await vi.waitFor(()=>expect(app.createGraphDocument().edges[0].manualRoute).toBeDefined());
    const after=app.createGraphDocument();
    expect(after.edges[0].manualRoute?.length).toBeGreaterThanOrEqual(2);
    expect(after.nodes).toEqual(before.nodes);
    click("undo-graph"); expect(app.createGraphDocument()).toEqual(before);
    app.openGraphDocument(after,"saved.depdoodle",false);
    expect(app.createGraphDocument().edges).toEqual(after.edges);
  });
  it("requires confirmation for auto layout too", async () => {
    const before=app.createGraphDocument(); click("auto-layout");
    await vi.waitFor(()=>expect(window.confirm).toHaveBeenCalled());
    expect(routing.layout).not.toHaveBeenCalled();
    expect(app.createGraphDocument()).toEqual(before);
  });
  it("requires confirmation before resetting saved route waypoints", async () => {
    const route=[{x:210,y:150},{x:245,y:150},{x:245,y:240},{x:300,y:240}];
    app.openGraphDocument({...graph(),edges:[{...graph().edges[0],manualRoute:route}]},"routed.depdoodle",false);
    (document.querySelector(".edge-hit") as Element).dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:245,clientY:150}));
    window.dispatchEvent(new MouseEvent("pointerup"));
    click("reset-edge-route"); document.querySelector("dialog")!.close("cancel"); await Promise.resolve();
    expect(app.createGraphDocument().edges[0].manualRoute).toEqual(route);
    click("reset-edge-route"); document.querySelector("dialog")!.close("reset");
    await vi.waitFor(()=>expect(app.createGraphDocument().edges[0].manualRoute).toBeUndefined());
    await app.ensureAutomaticRouting();
    expect(app.createGraphDocument().edges[0].manualRoute).toBeUndefined();
    expect(routing.layout).toHaveBeenCalledOnce();
  });
});

describe("native close decisions", () => {
  it("lets Tauri finish a clean close without requesting another close", async () => {
    const event={preventDefault:vi.fn()}; await app.handleNativeCloseRequest(event);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(native.close).not.toHaveBeenCalled();
  });
  it("lets Discard finish the original close request", async () => {
    edit("chart-title","Discard me"); const event={preventDefault:vi.fn()};
    const closing=app.handleNativeCloseRequest(event); document.querySelector("dialog")!.close("discard"); await closing;
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(native.close).not.toHaveBeenCalled();
    expect(localStorage.getItem("depdoodle.recovery")).toBeNull();
  });
  it("cancels a close but allows a later Discard attempt", async () => {
    edit("chart-title","Keep me"); const cancelled={preventDefault:vi.fn()};
    const first=app.handleNativeCloseRequest(cancelled); document.querySelector("dialog")!.close("cancel"); await first;
    expect(cancelled.preventDefault).toHaveBeenCalledOnce();
    const discarded={preventDefault:vi.fn()};
    const second=app.handleNativeCloseRequest(discarded); document.querySelector("dialog")!.close("discard"); await second;
    expect(discarded.preventDefault).not.toHaveBeenCalled();
  });
  it("keeps the window open if Save is cancelled", async () => {
    native.enabled=true; native.save.mockResolvedValue(null); edit("chart-title","Keep after cancelled save");
    const event={preventDefault:vi.fn()}; const closing=app.handleNativeCloseRequest(event);
    document.querySelector("dialog")!.close("save"); await closing;
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(native.close).not.toHaveBeenCalled();
  });
  it("allows a close after Save succeeds", async () => {
    native.enabled=true; native.save.mockResolvedValue("/tmp/saved.depdoodle"); native.write.mockResolvedValue(undefined); edit("chart-title","Saved before close");
    const event={preventDefault:vi.fn()}; const closing=app.handleNativeCloseRequest(event);
    document.querySelector("dialog")!.close("save"); await closing;
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(native.close).not.toHaveBeenCalled();
  });
  it("prevents simultaneous close requests from opening duplicate dialogs", async () => {
    edit("chart-title","Pending decision"); const first={preventDefault:vi.fn()},second={preventDefault:vi.fn()};
    const closing=app.handleNativeCloseRequest(first); await app.handleNativeCloseRequest(second);
    expect(second.preventDefault).toHaveBeenCalledOnce(); expect(document.querySelectorAll("dialog")).toHaveLength(1);
    document.querySelector("dialog")!.close("discard"); await closing;
    expect(first.preventDefault).not.toHaveBeenCalled();
  });
});
it("preserves interior waypoints rather than clamping or squaring them on load", () => {
  const route = [{x:210,y:159},{x:5000,y:999},{x:4900,y:1033},{x:300,y:159}];
  app.openGraphDocument({...graph(),edges:[{...graph().edges[0],manualRoute:route}]},"wide-route.depdoodle",false);
  const path=document.querySelector(".edge-path")?.getAttribute("d");
  expect(path).toContain("L 5000 999 L 4900 1033");
  expect(app.createGraphDocument().edges[0].manualRoute).toEqual(route);
  expect(app.createGraphDocument().world!.width).toBeGreaterThan(5000);
  expect(routing.layout).not.toHaveBeenCalled();
});

describe("automatic connections never reposition boxes", () => {
  it("creates bends on loading a file without saved routes or confirmation", async () => {
    const original={...graph(),nodes:[node("A",160),node("B",780)]};
    app.openGraphDocument(original,"legacy.depdoodle",false);
    await app.ensureAutomaticRouting();
    const positions=(items:typeof original.nodes)=>items.map(({id,x,y,width,height})=>({id,x,y,width,height}));
    expect(positions(app.createGraphDocument().nodes)).toEqual(positions(original.nodes));
    expect(routing.layout).toHaveBeenCalled();
    expect(routing.layout.mock.calls.every(call=>call[1].layout==="tala" && call[0].includes("left:"))).toBe(true);
    expect(document.querySelector(".edge-path")?.getAttribute("d")?.match(/L/g)?.length).toBeGreaterThan(1);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(app.createGraphDocument().edges[0].manualRoute).toBeUndefined();
  });
  it("keeps routes and box positions when inspecting or focusing the chart", () => {
    const before=app.createGraphDocument();
    const path=document.querySelector(".edge-path")?.getAttribute("d");
    (document.querySelector(".diagnostic") as HTMLElement).click();
    click("focus-upstream"); click("clear-focus"); click("view-pacing"); click("view-chart");
    expect(app.createGraphDocument()).toEqual(before);
    expect(document.querySelector(".edge-path")?.getAttribute("d")).toBe(path);
    expect(routing.layout).not.toHaveBeenCalled();
  });
  it("reroutes after a user drags a box without moving other boxes", async () => {
    const before=app.createGraphDocument();
    document.querySelector(".node[data-node-id='A']")!.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:10,clientY:110}));
    window.dispatchEvent(new MouseEvent("pointermove",{clientX:80,clientY:180}));
    expect(routing.layout).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("pointerup"));
    await app.ensureAutomaticRouting();
    expect(routing.layout).toHaveBeenCalledOnce();
    expect(routing.layout.mock.calls[0][0]).toContain("left:");
    expect(app.createGraphDocument().nodes.find(node=>node.id==="B")).toEqual(before.nodes.find(node=>node.id==="B"));
    expect(app.createGraphDocument().nodes.find(node=>node.id==="A")?.x).not.toBe(before.nodes.find(node=>node.id==="A")?.x);
  });
  it("recalculates connections after label edits without changing box positions", async () => {
    const before=app.createGraphDocument().nodes;
    document.querySelector(".edge-hit")!.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:250,clientY:159}));
    window.dispatchEvent(new MouseEvent("pointerup"));
    edit("edge-label","Brass key");
    await app.ensureAutomaticRouting();
    expect(routing.layout).toHaveBeenCalledOnce();
    expect(routing.layout.mock.calls[0][0]).toContain("left:");
    expect(app.createGraphDocument().nodes).toEqual(before);
  });
});

describe("background routing", () => {
  it("discards results for a graph closed while the worker was routing", async () => {
    const implementation = routing.layout.getMockImplementation()!;
    let finish!: () => void;
    routing.layout.mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return implementation(...args);
    });
    app.openGraphDocument(graph(), "old.depdoodle", false);
    const pending = app.ensureAutomaticRouting();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const replacement = { ...graph(), title: "Replacement", nodes: [node("A", 900), node("B", 1500)] };
    app.openGraphDocument(replacement, "replacement.depdoodle", false);
    finish();
    await pending;
    expect(app.createGraphDocument().nodes).toMatchObject(replacement.nodes);
    expect(document.querySelector(".edge-path")?.getAttribute("d")).toContain("M 1110");
    expect(document.querySelector("#save-status")?.textContent).toBe("Saved");
  });
  it("retries with the current positions when a box moves during routing", async () => {
    const implementation = routing.layout.getMockImplementation()!;
    let finish!: () => void;
    routing.layout.mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return implementation(...args);
    });
    app.openGraphDocument(graph(), "moving.depdoodle", false);
    const pending = app.ensureAutomaticRouting();
    await vi.waitFor(() => expect(finish).toBeDefined());
    document.querySelector(".node[data-node-id='A']")!.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:10,clientY:110}));
    window.dispatchEvent(new MouseEvent("pointermove",{clientX:80,clientY:180}));
    window.dispatchEvent(new MouseEvent("pointerup"));
    const moved = app.createGraphDocument().nodes;
    finish(); await pending;
    expect(app.createGraphDocument().nodes).toEqual(moved);
    expect(routing.layout.mock.calls.at(-1)?.[0]).toContain(`left: ${Math.round(moved[0].x)}; top: ${Math.round(moved[0].y)}`);
  });
  it("applies confirmed box layout as one undoable edit", async () => {
    const before = app.createGraphDocument();
    vi.mocked(window.confirm).mockReturnValue(true);
    await window.__depdoodleDebug!.autoLayout();
    expect(routing.layout.mock.calls.at(-1)?.[0]).not.toContain("left:");
    expect(app.createGraphDocument().nodes).not.toEqual(before.nodes);
    expect(app.createGraphDocument().edges[0].manualRoute).toBeDefined();
    click("undo-graph");
    expect(app.createGraphDocument()).toEqual(before);
  });
  it("does not apply a pending box layout to a newly opened document", async () => {
    const implementation = routing.layout.getMockImplementation()!;
    let finish!: () => void;
    routing.layout.mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return implementation(...args);
    });
    vi.mocked(window.confirm).mockReturnValue(true);
    const arranging = window.__depdoodleDebug!.autoLayout();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const replacement = { ...graph(), title: "Unchanged", nodes: [node("A",800),node("B",1600)] };
    app.openGraphDocument(replacement,"new.depdoodle",false);
    finish(); await arranging; await app.ensureAutomaticRouting();
    expect(app.createGraphDocument().nodes).toMatchObject(replacement.nodes);
    expect(app.createGraphDocument().edges[0].manualRoute).toBeUndefined();
  });
});

describe("live drag routing", () => {
  const move = (x: number, y: number) => window.dispatchEvent(new MouseEvent("pointermove", {clientX:x,clientY:y}));
  const release = () => window.dispatchEvent(new MouseEvent("pointerup"));
  const nextFrame = () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
  const rendered = () => ({
    path: document.querySelector(".edge-path")?.getAttribute("d"),
    arrow: document.querySelector(".edge-arrow")?.getAttribute("points"),
    labelX: document.querySelector(".edge-label")?.getAttribute("x"),
    labelY: document.querySelector(".edge-label")?.getAttribute("y"),
  });
  const start = () => document.querySelector(".node[data-node-id='A']")!.dispatchEvent(
    new MouseEvent("pointerdown", {bubbles:true,clientX:10,clientY:110}));

  it("does not change a connector or label just because a drag begins", async () => {
    app.openGraphDocument({...graph(), edges:[{...graph().edges[0],label:"Brass key"}]},"drag.depdoodle",false);
    await app.ensureAutomaticRouting();
    const before = rendered();
    start();
    expect(rendered()).toEqual(before);
    release();
    expect(rendered()).toEqual(before);
  });

  it("shows the final D2 route while holding a box and reuses it on release", async () => {
    app.openGraphDocument({...graph(), edges:[{...graph().edges[0],label:"Brass key"}]},"drag.depdoodle",false);
    await app.ensureAutomaticRouting(); routing.layout.mockClear();
    const before = rendered();
    const fixedBox = app.createGraphDocument().nodes[1];
    start(); move(80,180);
    await nextFrame(); await app.ensureAutomaticRouting();
    expect(routing.layout).toHaveBeenCalledOnce();
    const preview = rendered();
    expect(preview.path).not.toEqual(before.path);
    release(); await app.ensureAutomaticRouting();
    expect(rendered()).toEqual(preview);
    expect(routing.layout).toHaveBeenCalledOnce();
    expect(app.createGraphDocument().nodes[1]).toEqual(fixedBox);
    expect(app.createGraphDocument().edges[0].manualRoute).toBeUndefined();
  });

  it("does not recalculate when pointer events leave the box in the same grid position", async () => {
    start(); move(80,180);
    await nextFrame(); await app.ensureAutomaticRouting();
    routing.layout.mockClear();
    const preview = rendered();
    move(81,181);
    await nextFrame(); await app.ensureAutomaticRouting();
    expect(routing.layout).not.toHaveBeenCalled();
    expect(rendered()).toEqual(preview);
    release();
  });

  it("uses the same live route before and after releasing a group", async () => {
    app.openGraphDocument({...graph(), groups:[{id:"group",name:"Act",color:"#549aa3",hidden:false,nodeIds:["A","B"]}]},"group.depdoodle",false);
    await app.ensureAutomaticRouting(); routing.layout.mockClear();
    document.querySelector(".group-header")!.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:10,clientY:80}));
    move(90,180); await nextFrame(); await app.ensureAutomaticRouting();
    const preview = rendered();
    expect(routing.layout).toHaveBeenCalledOnce();
    release(); await app.ensureAutomaticRouting();
    expect(rendered()).toEqual(preview);
    expect(routing.layout).toHaveBeenCalledOnce();
  });

  it("keeps the chosen attachment side while a newer D2 route is pending", async () => {
    const implementation = routing.layout.getMockImplementation()!;
    let finish!: () => void;
    routing.layout.mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => {finish=resolve;});
      return implementation(...args);
    });
    start(); move(10,610);
    await nextFrame();
    await vi.waitFor(()=>expect(finish).toBeDefined());
    const moved = app.createGraphDocument().nodes[0];
    expect(rendered().path).toMatch(new RegExp(`^M ${moved.x + moved.width} ${moved.y + 59}(?: |$)`));
    finish(); await app.ensureAutomaticRouting(); release();
  });

  it("coalesces movements during a slow calculation and finishes the latest preview before release", async () => {
    const implementation = routing.layout.getMockImplementation()!;
    let finish!: () => void;
    routing.layout.mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => {finish=resolve;});
      return implementation(...args);
    });
    start(); move(80,180); await nextFrame();
    const pending = app.ensureAutomaticRouting();
    await vi.waitFor(()=>expect(finish).toBeDefined());
    move(160,260); await nextFrame();
    move(240,340); await nextFrame();
    expect(routing.layout).toHaveBeenCalledOnce();
    finish(); await pending;
    expect(routing.layout).toHaveBeenCalledTimes(2);
    const preview = rendered();
    const moved = app.createGraphDocument().nodes[0];
    expect(routing.layout.mock.calls.at(-1)?.[0]).toContain(`left: ${Math.round(moved.x)}; top: ${Math.round(moved.y)}`);
    release(); await app.ensureAutomaticRouting();
    expect(rendered()).toEqual(preview);
    expect(routing.layout).toHaveBeenCalledTimes(2);
  });
});

describe("toggleable check highlights", () => {
  const check = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".diagnostic")].find(button => button.textContent?.includes(text))!;
  const highlighted = () => [...document.querySelectorAll<HTMLElement>(".node.check-highlighted")].map(element=>element.dataset.nodeId).sort();
  const dimmed = () => [...document.querySelectorAll<HTMLElement>(".node.check-dimmed")].map(element=>element.dataset.nodeId).sort();
  const threeNodes = () => ({...graph(),nodes:[...graph().nodes,node("C",650)],groups:[{id:"act",name:"Act",color:"#549aa3",nodeIds:["A","B","C"],hidden:false}]});

  it("toggles each check, combines matches, and restores normal rendering after the last deselection", async () => {
    app.openGraphDocument(threeNodes(),"checks.depdoodle",false);
    await app.ensureAutomaticRouting(); routing.layout.mockClear();
    const before = app.createGraphDocument();
    const path = document.querySelector(".edge-path")?.getAttribute("d");
    const zoom = document.getElementById("zoom-level")?.textContent;
    check("Non-reward leaf: B.").click();
    expect(check("Non-reward leaf: B.").getAttribute("aria-pressed")).toBe("true");
    expect(highlighted()).toEqual(["B"]);
    expect(dimmed()).toEqual(["A","C"]);
    expect(document.querySelector(".group-box")?.classList.contains("check-dimmed")).toBe(true);
    check("Non-reward leaf: C.").click();
    expect(document.querySelectorAll('.diagnostic[aria-pressed="true"]')).toHaveLength(2);
    expect(highlighted()).toEqual(["B","C"]);
    expect(dimmed()).toEqual(["A"]);
    check("Non-reward leaf: B.").click();
    expect(highlighted()).toEqual(["C"]);
    expect(dimmed()).toEqual(["A","B"]);
    check("Non-reward leaf: C.").click();
    expect(document.querySelectorAll(".check-dimmed, .check-highlighted, .node.selected")).toHaveLength(0);
    expect(document.querySelectorAll('.diagnostic[aria-pressed="true"]')).toHaveLength(0);
    expect(app.createGraphDocument()).toEqual(before);
    expect(document.querySelector(".edge-path")?.getAttribute("d")).toBe(path);
    expect(document.getElementById("zoom-level")?.textContent).toBe(zoom);
    expect(routing.layout).not.toHaveBeenCalled();
  });

  it("keeps shared matches highlighted when one overlapping check is deselected", async () => {
    const fixture = {...graph(true), nodes:[...graph().nodes,node("C",650)]};
    fixture.nodes[1] = {...fixture.nodes[1], narrativeReferences:["C"]} as typeof fixture.nodes[number];
    app.openGraphDocument(fixture,"overlap.depdoodle",false);
    await app.ensureAutomaticRouting();
    check("Cycle detected").click();
    expect(highlighted()).toEqual(["A","B"]);
    expect(document.querySelectorAll(".edge-group.check-highlighted")).toHaveLength(2);
    check("narrative reference").click();
    expect(highlighted()).toEqual(["A","B","C"]);
    check("Cycle detected").click();
    expect(highlighted()).toEqual(["B","C"]);
    expect(dimmed()).toEqual(["A"]);
    expect(document.querySelectorAll(".edge-group.check-highlighted")).toHaveLength(0);
    expect(check("narrative reference").getAttribute("aria-pressed")).toBe("true");
  });

  it("retains check identity after renaming a node and drops highlights once the warning is resolved", async () => {
    app.openGraphDocument(threeNodes(),"renamed.depdoodle",false);
    await app.ensureAutomaticRouting();
    check("Non-reward leaf: C.").click();
    const key = check("Non-reward leaf: C.").dataset.diagnostic;
    edit("node-title","Renamed leaf");
    expect(check("Renamed leaf").dataset.diagnostic).toBe(key);
    expect(check("Renamed leaf").getAttribute("aria-pressed")).toBe("true");
    expect(highlighted()).toEqual(["C"]);
    const kind = document.getElementById("node-kind") as HTMLSelectElement;
    kind.value = "reward"; kind.dispatchEvent(new Event("change"));
    expect(document.querySelectorAll(".check-dimmed, .check-highlighted")).toHaveLength(0);
    expect(check("Non-reward leaf: B.").getAttribute("aria-pressed")).toBe("false");
  });

  it("preserves highlights through redraws and in the pacing view", async () => {
    check("Non-reward leaf: B.").click();
    click("view-pacing");
    expect(document.querySelector('.pacing-bar[data-node-id="B"]')?.classList.contains("check-highlighted")).toBe(true);
    expect(document.querySelector('.pacing-bar[data-node-id="A"]')?.classList.contains("check-dimmed")).toBe(true);
    click("view-chart");
    expect(highlighted()).toEqual(["B"]);
    expect(check("Non-reward leaf: B.").getAttribute("aria-pressed")).toBe("true");
  });

  it("does not carry selected checks into another document", () => {
    check("Non-reward leaf: B.").click();
    app.openGraphDocument(graph(),"other.depdoodle",false);
    expect(document.querySelectorAll(".check-dimmed, .check-highlighted")).toHaveLength(0);
    expect(document.querySelectorAll('.diagnostic[aria-pressed="true"]')).toHaveLength(0);
  });
});

it("highlights connections between elements from multiple selected checks", async () => {
  const roots = Array.from({length:6},(_,i)=>node(`Root ${i}`,i*240));
  const leaves = Array.from({length:6},(_,i)=>({...node(`Leaf ${i}`,i*240),y:400,kind:"reward" as const}));
  const links = roots.map((root,i)=>({id:`link${i}`,from:root.id,to:leaves[i].id,label:"",tokenType:"state" as const}));
  app.openGraphDocument({...graph(),nodes:[...roots,...leaves],edges:links},"layers.depdoodle",false);
  await app.ensureAutomaticRouting();
  const checks = () => [...document.querySelectorAll<HTMLButtonElement>(".diagnostic")].filter(button=>button.textContent?.includes("Broad layer"));
  checks()[0].click();
  expect(document.querySelectorAll(".edge-group.check-highlighted")).toHaveLength(0);
  checks()[1].click();
  expect(document.querySelectorAll(".edge-group.check-highlighted")).toHaveLength(6);
});

describe("interactive playthrough", () => {
  const enable = () => {
    const toggle = document.getElementById("simulate-toggle") as HTMLInputElement;
    toggle.checked = true; toggle.dispatchEvent(new Event("change"));
  };
  const box = (id: string) => document.querySelector<HTMLElement>(`.node[data-node-id='${id}']`)!;
  const link = (id: string) => document.querySelector<SVGGElement>(`.edge-group[data-edge-id='${id}']`)!;
  const solve = (id: string) => (box(id).querySelector("[data-toggle-solved]") as HTMLButtonElement).click();
  const chain = () => ({...graph(),nodes:[...graph().nodes,node("C",600)],edges:[...graph().edges,{id:"bc",from:"B",to:"C",label:"Door",tokenType:"access" as const}]});

  it("marks solved boxes with an X and animates only arrows to available next steps", async () => {
    app.openGraphDocument(chain(),"playthrough.depdoodle",false);
    await app.ensureAutomaticRouting(); routing.layout.mockClear();
    const before = app.createGraphDocument();
    const path = link("ab").querySelector(".edge-path")!.getAttribute("d");
    enable();
    expect(box("B").classList.contains("simulation-blocked")).toBe(true);
    expect(box("C").classList.contains("simulation-blocked")).toBe(true);
    expect(box("B").querySelector("[data-toggle-solved]")).toBeNull();
    solve("A");
    expect(box("A").querySelector(".completion-cross path")).not.toBeNull();
    expect(box("B").classList.contains("simulation-available")).toBe(true);
    expect(link("ab").classList.contains("simulation-flowing")).toBe(true);
    expect(link("ab").querySelector(".edge-flow")!.getAttribute("d")).toBe(path);
    expect(link("bc").classList.contains("simulation-blocked")).toBe(true);
    expect(link("bc").querySelector(".edge-flow")).toBeNull();
    expect(document.getElementById("save-status")?.textContent).toBe("Saved");
    expect(app.createGraphDocument()).toEqual(before);
    expect(routing.layout).not.toHaveBeenCalled();
  });

  it("advances the animated arrows and removes dependent completions when a prerequisite is undone", async () => {
    app.openGraphDocument(chain(),"undo-playthrough.depdoodle",false);
    await app.ensureAutomaticRouting(); enable();
    solve("A"); solve("B");
    expect(document.querySelectorAll(".node .completion-cross")).toHaveLength(2);
    expect(link("ab").classList.contains("simulation-traversed")).toBe(true);
    expect(link("ab").querySelector(".edge-flow")).toBeNull();
    expect(link("bc").querySelector(".edge-flow")).not.toBeNull();
    solve("A");
    expect(document.querySelectorAll(".completion-cross, .edge-flow")).toHaveLength(0);
    expect(box("A").classList.contains("simulation-available")).toBe(true);
    expect(box("B").classList.contains("simulation-blocked")).toBe(true);
    expect(box("C").classList.contains("simulation-blocked")).toBe(true);
  });

  it("keeps an AND gate inaccessible until all its prerequisites are solved", async () => {
    const fixture = {...graph(),nodes:[node("A"),node("B",300),node("Gate",600)],edges:[
      {id:"ag",from:"A",to:"Gate",label:"",tokenType:"state" as const},
      {id:"bg",from:"B",to:"Gate",label:"",tokenType:"state" as const},
    ]};
    app.openGraphDocument(fixture,"and.depdoodle",false); await app.ensureAutomaticRouting(); enable();
    solve("A");
    expect(box("Gate").classList.contains("simulation-blocked")).toBe(true);
    expect(document.querySelectorAll(".edge-flow")).toHaveLength(0);
    solve("B");
    expect(box("Gate").classList.contains("simulation-available")).toBe(true);
    expect(document.querySelectorAll(".edge-flow")).toHaveLength(2);
  });

  it("animates only satisfied OR alternatives and preserves completion while an alternative remains solved", async () => {
    const fixture = {...graph(),nodes:[node("A"),node("B",300),{...node("Gate",600),prerequisiteMode:"any" as const}],edges:[
      {id:"ag",from:"A",to:"Gate",label:"",tokenType:"state" as const},
      {id:"bg",from:"B",to:"Gate",label:"",tokenType:"state" as const},
    ]};
    app.openGraphDocument(fixture,"or.depdoodle",false); await app.ensureAutomaticRouting(); enable();
    solve("A");
    expect(box("Gate").classList.contains("simulation-available")).toBe(true);
    expect(link("ag").querySelector(".edge-flow")).not.toBeNull();
    expect(link("bg").querySelector(".edge-flow")).toBeNull();
    solve("B"); solve("Gate"); solve("A");
    expect(box("Gate").querySelector(".completion-cross")).not.toBeNull();
    solve("B");
    expect(box("Gate").querySelector(".completion-cross")).toBeNull();
    expect(box("Gate").classList.contains("simulation-blocked")).toBe(true);
  });

  it("clears simulation decoration when disabled or reset and mirrors completion in the pacing view", () => {
    enable(); solve("A"); click("view-pacing");
    expect(document.querySelector('.pacing-bar[data-node-id="A"] .completion-cross')).not.toBeNull();
    expect(document.querySelector('.pacing-bar[data-node-id="B"]')?.classList.contains("simulation-available")).toBe(true);
    const toggle = document.getElementById("simulate-toggle") as HTMLInputElement;
    toggle.checked = false; toggle.dispatchEvent(new Event("change"));
    expect(document.querySelectorAll(".completion-cross, .edge-flow, .simulation-blocked, .simulation-complete, .simulation-available")).toHaveLength(0);
    enable();
    expect(document.querySelector('.pacing-bar[data-node-id="A"] .completion-cross')).not.toBeNull();
    click("reset-simulation");
    expect(document.querySelectorAll(".completion-cross, .edge-flow")).toHaveLength(0);
    expect(document.getElementById("simulation-panel")?.textContent).toContain("0 solved");
  });

  it("does not drag a box when using its Solve button", () => {
    enable();
    const before = app.createGraphDocument();
    const button = box("A").querySelector("[data-toggle-solved]")!;
    button.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:20,clientY:210}));
    window.dispatchEvent(new MouseEvent("pointermove",{clientX:600,clientY:500}));
    window.dispatchEvent(new MouseEvent("pointerup"));
    (button as HTMLButtonElement).click();
    expect(app.createGraphDocument()).toEqual(before);
    expect(box("A").querySelector(".completion-cross")).not.toBeNull();
  });
});
