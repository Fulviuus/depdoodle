import {
  Activity,
  createIcons,
  Download,
  FilePlus2,
  FolderOpen,
  GitBranchPlus,
  History,
  House,
  Layers3,
  Maximize2,
  Moon,
  MousePointer2,
  Save,
  ZoomIn,
  ZoomOut,
  PanelRight,
  SquarePlus,
  Sun,
  Trash2,
  TriangleAlert,
  Workflow,
} from "lucide";
import { Graphviz } from "@hpcc-js/wasm-graphviz";
import { isTauri } from "@tauri-apps/api/core";
import { save as showSaveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";

type NodeKind = "puzzle" | "gate" | "reward";
type Tool = "select" | "node" | "connect";
type ThemeMode = "light" | "dark";
type ExportFormat = "png" | "jpg" | "pdf";

interface PuzzleNode {
  id: string;
  title: string;
  note: string;
  kind: NodeKind;
  color: string;
  act: string;
  difficulty?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DependencyEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  tokenType: "item" | "access" | "fact" | "state" | "permission";
}

interface GraphDocumentV1 {
  format: "depdoodle.graph";
  version: 1;
  title: string;
  description?: string;
  world?: {
    width?: number;
    height?: number;
  };
  nodes: PuzzleNode[];
  edges: DependencyEdge[];
}

interface LoadedGraph {
  title: string;
  sourceName: string;
  description?: string;
  filePath?: string;
}

interface RecentGraph {
  id: string;
  title: string;
  sourceName: string;
  openedAt: string;
  document: GraphDocumentV1;
  filePath?: string;
}

interface Point {
  x: number;
  y: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface DragState {
  nodeId: string;
  offsetX: number;
  offsetY: number;
}

interface Topology {
  hasCycle: boolean;
  order: PuzzleNode[];
  layerByNode: Map<string, number>;
  layers: PuzzleNode[][];
}

interface GraphAnalysis {
  roots: PuzzleNode[];
  leaves: PuzzleNode[];
  bottlenecks: PuzzleNode[];
  warnings: string[];
  topology: Topology;
  maxLayerWidth: number;
}

interface GraphvizNodeLayout {
  center: Point;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GraphvizEdgeLayout {
  path: string;
  arrowPoints: Point[];
  labelX: number;
  labelY: number;
}

interface GraphvizLayout {
  width: number;
  height: number;
  nodes: Map<string, GraphvizNodeLayout>;
  edges: Map<string, GraphvizEdgeLayout>;
}

interface GraphvizDrawOp {
  op: string;
  points?: number[][];
  pt?: number[];
  text?: string;
}

interface GraphvizJsonNode {
  name: string;
  pos?: string;
  width?: string;
  height?: string;
}

interface GraphvizJsonEdge {
  edgeId?: string;
  label?: string;
  xlabel?: string;
  pos?: string;
  lp?: string;
  xlp?: string;
  _draw_?: GraphvizDrawOp[];
  _hdraw_?: GraphvizDrawOp[];
  _ldraw_?: GraphvizDrawOp[];
}

interface GraphvizJson {
  bb?: string;
  objects?: GraphvizJsonNode[];
  edges?: GraphvizJsonEdge[];
}

declare global {
  interface Window {
    __depdoodleDebug?: {
      autoLayout: () => void;
      labelAttachmentReport: () => ReturnType<typeof edgeLabelAttachmentReport>;
      loadGraph: (document: GraphDocumentV1) => void;
      waitForGraphviz: () => Promise<void>;
    };
  }
}

const EDGE_LABEL_MIN_WIDTH = 68;
const EDGE_LABEL_MAX_WIDTH = 320;
const EDGE_LABEL_HEIGHT = 24;
const EDGE_LABEL_HORIZONTAL_PADDING = 24;
const EDGE_LABEL_SIDE_GUTTER = 144;
const EDGE_LABEL_CLEARANCE = 10;
const EDGE_ROUTE_CLEARANCE = 8;
const GRAPHVIZ_POINTS_PER_INCH = 72;
const MIN_AUTO_NODESEP = 1.35;
const MIN_AUTO_RANKSEP = 3.6;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.2;
const EXPORT_PADDING = 56;
const MAX_EXPORT_PIXELS = 24_000_000;
const RECENT_GRAPHS_STORAGE_KEY = "depdoodle.recentGraphs";
const THEME_STORAGE_KEY = "depdoodle.theme";
const EMPTY_GRAPH_WORLD = { width: 1680, height: 1040 };

let world = {
  ...EMPTY_GRAPH_WORLD,
};

let nodes: PuzzleNode[] = [];
let edges: DependencyEdge[] = [];
let currentGraph: LoadedGraph | null = null;
let recentGraphs: RecentGraph[] = loadRecentGraphs();

let selectedNodeId: string | null = null;
let selectedEdgeId: string | null = null;
let activeTool: Tool = "select";
let pendingConnectionFrom: string | null = null;
let dragState: DragState | null = null;
let nodeSerial = nodes.length + 1;
let edgeSerial = edges.length + 1;
let graphviz: Graphviz | null = null;
let graphvizLayout: GraphvizLayout | null = null;
let graphvizError: string | null = null;
let graphvizRoutingDirty = true;
let nodeGhostPosition: Point | null = null;
let edgeLabelMeasureContext: CanvasRenderingContext2D | null = null;
let zoom = 1;
let themeMode: ThemeMode = loadThemeMode();
let exportMenuOpen = false;

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app mount point");
}

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <strong>DepDoodle</strong>
        <span>Puzzle Dependency Charts</span>
      </div>
      <nav class="toolbar" aria-label="Chart tools">
        <button class="tool-button" id="back-to-welcome" type="button" title="Back to welcome">
          <i data-lucide="house"></i>
          <span>Welcome</span>
        </button>
        <span class="toolbar-separator" aria-hidden="true"></span>
        <button class="tool-button" id="save-graph" type="button" title="Save graph as .depdoodle">
          <i data-lucide="save"></i>
          <span>Save</span>
        </button>
        <div class="export-control">
          <button class="tool-button" id="export-graph" type="button" title="Export chart" aria-haspopup="menu" aria-expanded="false">
            <i data-lucide="download"></i>
            <span>Export</span>
          </button>
          <div class="export-menu" id="export-menu" role="menu" hidden>
            <button type="button" role="menuitem" data-export-format="png">PNG</button>
            <button type="button" role="menuitem" data-export-format="jpg">JPG</button>
            <button type="button" role="menuitem" data-export-format="pdf">PDF</button>
          </div>
        </div>
        <span class="toolbar-separator" aria-hidden="true"></span>
        <button class="tool-button" id="tool-select" type="button" title="Select and move nodes">
          <i data-lucide="mouse-pointer-2"></i>
          <span>Select</span>
        </button>
        <button class="tool-button" id="tool-node" type="button" title="Click the canvas to add a puzzle">
          <i data-lucide="square-plus"></i>
          <span>Node</span>
        </button>
        <button class="tool-button" id="tool-connect" type="button" title="Click one node, then another, to add a dependency">
          <i data-lucide="git-branch-plus"></i>
          <span>Connect</span>
        </button>
        <span class="toolbar-separator" aria-hidden="true"></span>
        <button class="tool-button" id="auto-layout" type="button" title="Auto layout">
          <i data-lucide="workflow"></i>
          <span id="layout-action-label">Auto Layout</span>
        </button>
        <span class="toolbar-separator" aria-hidden="true"></span>
        <div class="zoom-control" aria-label="Canvas zoom">
          <button class="tool-button icon-tool" id="zoom-out" type="button" title="Zoom out" aria-label="Zoom out">
            <i data-lucide="zoom-out"></i>
          </button>
          <button class="tool-button zoom-reset" id="zoom-reset" type="button" title="Reset zoom to 100%">
            <span id="zoom-level">100%</span>
          </button>
          <button class="tool-button icon-tool" id="zoom-in" type="button" title="Zoom in" aria-label="Zoom in">
            <i data-lucide="zoom-in"></i>
          </button>
          <button class="tool-button icon-tool" id="zoom-fit" type="button" title="Fit chart to view" aria-label="Fit chart to view">
            <i data-lucide="maximize-2"></i>
          </button>
        </div>
      </nav>
      <button class="theme-toggle" id="theme-toggle" type="button" aria-pressed="false" title="Switch to dark theme">
        <span class="theme-toggle-track" aria-hidden="true">
          <i class="theme-icon theme-icon-light" data-lucide="sun"></i>
          <i class="theme-icon theme-icon-dark" data-lucide="moon"></i>
          <span class="theme-toggle-thumb"></span>
        </span>
        <span id="theme-label">Light</span>
      </button>
    </header>

    <main class="welcome-screen" id="welcome-screen">
      <section class="welcome-main">
        <img class="welcome-logo" src="/depdoodle-logo.png" alt="DepDoodle" />
        <h1>Puzzle dependency charts</h1>
        <p class="welcome-copy">Create a chart, load a saved <code>.depdoodle</code> graph, or reopen recent work.</p>
        <div class="welcome-actions">
          <button class="welcome-action primary" id="new-graph" type="button">
            <i data-lucide="file-plus-2"></i>
            <span>New Graph</span>
          </button>
          <button class="welcome-action" id="load-graph" type="button">
            <i data-lucide="folder-open"></i>
            <span>Load Graph</span>
          </button>
        </div>
      </section>

      <aside class="recent-sidebar">
        <div class="recent-heading">
          <i data-lucide="history"></i>
          <h2>Recent Files</h2>
        </div>
        <div class="recent-list" id="recent-list"></div>
      </aside>
    </main>

    <div class="workbench" id="workbench">
      <aside class="analysis-pane">
        <section>
          <div class="pane-heading">
            <i data-lucide="activity"></i>
            <h2>Structure</h2>
          </div>
          <div class="metric-grid" id="metric-grid"></div>
        </section>

        <section>
          <div class="pane-heading">
            <i data-lucide="layers-3"></i>
            <h2>Branch Width</h2>
          </div>
          <div class="width-bars" id="width-bars"></div>
        </section>

        <section>
          <div class="pane-heading">
            <i data-lucide="triangle-alert"></i>
            <h2>Checks</h2>
          </div>
          <div class="warnings" id="warnings"></div>
        </section>
      </aside>

      <main class="canvas-pane">
        <div class="canvas-ruler horizontal"></div>
        <div class="canvas-ruler vertical"></div>
        <div class="canvas-scroll" id="canvas-scroll">
          <div class="graph-viewport" id="graph-viewport">
            <div class="graph-space" id="graph-space">
              <svg class="edge-layer" id="edge-layer" width="${world.width}" height="${world.height}" viewBox="0 0 ${world.width} ${world.height}">
              </svg>
              <div class="node-layer" id="node-layer"></div>
            </div>
          </div>
        </div>
      </main>

      <aside class="inspector-pane">
        <section>
          <div class="pane-heading">
            <i data-lucide="panel-right"></i>
            <h2>Inspector</h2>
          </div>
          <div id="inspector"></div>
        </section>
      </aside>
    </div>
    <input class="hidden-file-input" id="graph-file-input" type="file" accept=".depdoodle,.depdoodle.json,application/json" />
  </div>
`;

const appShell = must<HTMLDivElement>(".app-shell");
const welcomeScreen = must<HTMLElement>("#welcome-screen");
const workbench = must<HTMLDivElement>("#workbench");
const graphSpace = must<HTMLDivElement>("#graph-space");
const graphViewport = must<HTMLDivElement>("#graph-viewport");
const edgeLayer = must<SVGSVGElement>("#edge-layer");
const nodeLayer = must<HTMLDivElement>("#node-layer");
const inspector = must<HTMLDivElement>("#inspector");
const metricGrid = must<HTMLDivElement>("#metric-grid");
const widthBars = must<HTMLDivElement>("#width-bars");
const warningsPanel = must<HTMLDivElement>("#warnings");
const canvasScroll = must<HTMLDivElement>("#canvas-scroll");
const themeToggle = must<HTMLButtonElement>("#theme-toggle");
const themeLabel = must<HTMLSpanElement>("#theme-label");
const autoLayoutButton = must<HTMLButtonElement>("#auto-layout");
const layoutActionLabel = must<HTMLSpanElement>("#layout-action-label");
const zoomLevel = must<HTMLSpanElement>("#zoom-level");
const zoomOutButton = must<HTMLButtonElement>("#zoom-out");
const zoomInButton = must<HTMLButtonElement>("#zoom-in");
const graphFileInput = must<HTMLInputElement>("#graph-file-input");
const recentList = must<HTMLDivElement>("#recent-list");
const exportButton = must<HTMLButtonElement>("#export-graph");
const exportMenu = must<HTMLDivElement>("#export-menu");

resizeWorld(world.width, world.height);
applyTheme(themeMode);

must<HTMLButtonElement>("#new-graph").addEventListener("click", () => {
  createNewGraph();
});

must<HTMLButtonElement>("#load-graph").addEventListener("click", () => {
  graphFileInput.click();
});

graphFileInput.addEventListener("change", () => {
  void handleGraphFileInput();
});

must<HTMLButtonElement>("#back-to-welcome").addEventListener("click", () => {
  showWelcomeScreen();
});

must<HTMLButtonElement>("#save-graph").addEventListener("click", () => {
  void saveGraph();
});

exportButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setExportMenuOpen(!exportMenuOpen);
});

exportMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const target = event.target;

  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const format = target.dataset.exportFormat;

  if (!isExportFormat(format)) {
    return;
  }

  setExportMenuOpen(false);
  void exportGraph(format);
});

themeToggle.addEventListener("click", () => {
  setTheme(themeMode === "dark" ? "light" : "dark");
});

must<HTMLButtonElement>("#tool-select").addEventListener("click", () => {
  setTool("select");
});

must<HTMLButtonElement>("#tool-node").addEventListener("click", () => {
  setTool("node");
});

must<HTMLButtonElement>("#tool-connect").addEventListener("click", () => {
  setTool("connect");
});

autoLayoutButton.addEventListener("click", () => {
  autoArrange();
});

zoomOutButton.addEventListener("click", () => {
  setZoom(zoom / ZOOM_STEP);
});

zoomInButton.addEventListener("click", () => {
  setZoom(zoom * ZOOM_STEP);
});

must<HTMLButtonElement>("#zoom-reset").addEventListener("click", () => {
  setZoom(1);
});

must<HTMLButtonElement>("#zoom-fit").addEventListener("click", () => {
  fitGraphToView();
});

canvasScroll.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    event.preventDefault();
    setZoom(zoom * (event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP), {
      clientX: event.clientX,
      clientY: event.clientY,
    });
  },
  { passive: false },
);

graphSpace.addEventListener("pointermove", (event) => {
  if (activeTool !== "node") {
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);

  nodeGhostPosition = clampNodePosition(point.x - 105, point.y - 58);
  renderNodeGhost();
});

graphSpace.addEventListener("pointerleave", () => {
  if (activeTool !== "node") {
    return;
  }

  nodeGhostPosition = null;
  renderNodeGhost();
});

graphSpace.addEventListener("pointerdown", (event) => {
  const target = event.target as Element;

  if (target.closest(".node") || target.closest(".edge-hit")) {
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);

  if (activeTool === "node") {
    const ghostPosition = nodeGhostPosition ?? clampNodePosition(point.x - 105, point.y - 58);
    addNodeAt(ghostPosition.x, ghostPosition.y);
    return;
  }

  selectedNodeId = null;
  selectedEdgeId = null;
  pendingConnectionFrom = null;
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setExportMenuOpen(false);
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveGraph();
    return;
  }

  const target = event.target as HTMLElement | null;
  const isEditing =
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    target?.tagName === "SELECT";

  if (isEditing) {
    return;
  }

  if (event.metaKey || event.ctrlKey) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom(zoom * ZOOM_STEP);
      return;
    }

    if (event.key === "-") {
      event.preventDefault();
      setZoom(zoom / ZOOM_STEP);
      return;
    }

    if (event.key === "0") {
      event.preventDefault();
      setZoom(1);
      return;
    }
  }

  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    deleteSelection();
  }

  if (event.key.toLowerCase() === "v") {
    setTool("select");
  }

  if (event.key.toLowerCase() === "n") {
    setTool("node");
  }

  if (event.key.toLowerCase() === "c") {
    setTool("connect");
  }

  if (event.key.toLowerCase() === "l") {
    autoArrange();
  }
});

document.addEventListener("click", () => {
  setExportMenuOpen(false);
});

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing element ${selector}`);
  }

  return element;
}

function setTool(tool: Tool) {
  activeTool = tool;
  pendingConnectionFrom = null;
  nodeGhostPosition = null;
  render();
}

function addNodeAt(x: number, y: number) {
  const position = clampNodePosition(x, y);
  const node: PuzzleNode = {
    id: `n-custom-${nodeSerial}`,
    title: `Puzzle ${nodeSerial}`,
    note: "Describe the player action and the dependency token it creates.",
    kind: "puzzle",
    color: defaultNodeColor("puzzle", "Act I"),
    act: "Act I",
    x: position.x,
    y: position.y,
    width: 210,
    height: 118,
  };

  nodeSerial += 1;
  nodes = [...nodes, node];
  selectedNodeId = node.id;
  selectedEdgeId = null;
  activeTool = "select";
  nodeGhostPosition = null;
  render();
}

function addDependency(from: string, to: string) {
  if (from === to || edges.some((edge) => edge.from === from && edge.to === to)) {
    pendingConnectionFrom = null;
    setTool("select");
    return;
  }

  const edge: DependencyEdge = {
    id: `e-custom-${edgeSerial}`,
    from,
    to,
    label: "",
    tokenType: "state",
  };

  edgeSerial += 1;
  edges = [...edges, edge];
  selectedNodeId = null;
  selectedEdgeId = edge.id;
  pendingConnectionFrom = null;
  activeTool = "select";
  markGraphvizRoutingDirty();
  render();
}

function createNewGraph() {
  openGraphDocument(
    {
      format: "depdoodle.graph",
      version: 1,
      title: "Untitled Graph",
      world: { ...EMPTY_GRAPH_WORLD },
      nodes: [],
      edges: [],
    },
    "Unsaved graph",
    false,
  );
}

async function handleGraphFileInput() {
  const file = graphFileInput.files?.[0];
  graphFileInput.value = "";

  if (!file) {
    return;
  }

  try {
    const document = normalizeGraphDocument(JSON.parse(await file.text()));
    openGraphDocument(document, file.name);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to load graph file.");
  }
}

function openGraphDocument(document: GraphDocumentV1, sourceName: string, updateRecent = true, filePath?: string) {
  const normalized = normalizeGraphDocument(document);
  nodes = normalized.nodes.map((node) => ({ ...node }));
  edges = normalized.edges.map((edge) => ({ ...edge }));
  currentGraph = {
    title: normalized.title,
    sourceName,
    description: normalized.description,
    filePath,
  };
  nodeSerial = nextSerial(nodes.map((node) => node.id), "n-custom-");
  edgeSerial = nextSerial(edges.map((edge) => edge.id), "e-custom-");
  selectedNodeId = null;
  selectedEdgeId = null;
  pendingConnectionFrom = null;
  activeTool = "select";
  nodeGhostPosition = null;
  graphvizLayout = null;
  graphvizRoutingDirty = true;
  zoom = 1;

  const measured = measureGraphBounds(nodes);
  resizeWorld(
    Math.max(normalized.world?.width ?? 0, measured.width, EMPTY_GRAPH_WORLD.width),
    Math.max(normalized.world?.height ?? 0, measured.height, EMPTY_GRAPH_WORLD.height),
  );

  canvasScroll.scrollLeft = 0;
  canvasScroll.scrollTop = 0;

  if (updateRecent) {
    rememberGraph(normalized, sourceName, filePath);
  }

  render();
}

function showWelcomeScreen() {
  currentGraph = null;
  selectedNodeId = null;
  selectedEdgeId = null;
  pendingConnectionFrom = null;
  activeTool = "select";
  nodeGhostPosition = null;
  setExportMenuOpen(false);
  render();
}

function setExportMenuOpen(open: boolean) {
  exportMenuOpen = open && currentGraph !== null;
  exportMenu.hidden = !exportMenuOpen;
  exportButton.setAttribute("aria-expanded", String(exportMenuOpen));
}

async function saveGraph() {
  if (!currentGraph) {
    return;
  }

  const document = createGraphDocument();
  const filename = graphFilename(document.title, currentGraph.sourceName, "depdoodle");
  const contents = `${JSON.stringify(document, null, 2)}\n`;

  try {
    if (isTauriRuntime()) {
      const filePath =
        currentGraph.filePath ??
        (await showSaveDialog({
          title: "Save DepDoodle Graph",
          defaultPath: filename,
          filters: [{ name: "DepDoodle", extensions: ["depdoodle"] }],
          canCreateDirectories: true,
        }));

      if (!filePath) {
        return;
      }

      const outputPath = ensureFileExtension(filePath, "depdoodle");
      await writeTextFile(outputPath, contents);
      const sourceName = filePathDisplayName(outputPath);
      currentGraph = { ...currentGraph, sourceName, filePath: outputPath };
      rememberGraph(document, sourceName, outputPath);
      return;
    }

    const blob = new Blob([contents], {
      type: "application/json",
    });

    downloadBlob(blob, filename);
    currentGraph = { ...currentGraph, sourceName: filename };
    rememberGraph(document, filename);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to save graph.");
  }
}

async function exportGraph(format: ExportFormat) {
  if (!currentGraph) {
    return;
  }

  try {
    const basename = graphFilenameBase(currentGraph.title, currentGraph.sourceName);
    const extension = extensionForExportFormat(format);
    const filename = `${basename}.${extension}`;

    if (isTauriRuntime()) {
      const filePath = await showSaveDialog({
        title: `Export ${format.toUpperCase()}`,
        defaultPath: filename,
        filters: [filterForExportFormat(format)],
        canCreateDirectories: true,
      });

      if (!filePath) {
        return;
      }

      const canvas = renderGraphToCanvas();
      const blob = await blobForExportFormat(canvas, format);
      await writeFile(
        ensureFileExtension(filePath, extension, acceptedExtensionsForExportFormat(format)),
        new Uint8Array(await blob.arrayBuffer()),
      );
      return;
    }

    const canvas = renderGraphToCanvas();

    if (format === "png") {
      downloadBlob(await blobForExportFormat(canvas, format), filename);
      return;
    }

    if (format === "jpg") {
      downloadBlob(await blobForExportFormat(canvas, format), filename);
      return;
    }

    downloadBlob(await blobForExportFormat(canvas, format), filename);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to export chart.");
  }
}

function createGraphDocument(): GraphDocumentV1 {
  return {
    format: "depdoodle.graph",
    version: 1,
    title: currentGraph?.title ?? "Untitled Graph",
    description: currentGraph?.description,
    world: { ...world },
    nodes: nodes.map((node) => ({ ...node })),
    edges: edges.map((edge) => ({ ...edge })),
  };
}

function renderGraphToCanvas() {
  refreshGraphvizRoutingIfNeeded();

  const bounds = measureExportBounds();
  const scale = exportScale(bounds.width, bounds.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
  canvas.height = Math.max(1, Math.ceil(bounds.height * scale));

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create export canvas.");
  }

  context.scale(scale, scale);
  drawExportBackground(context, bounds);
  context.translate(-bounds.left, -bounds.top);
  drawExportEdges(context);
  drawExportNodes(context);

  return canvas;
}

function measureExportBounds() {
  const xs: number[] = [];
  const ys: number[] = [];

  nodes.forEach((node) => {
    xs.push(node.x, node.x + node.width);
    ys.push(node.y, node.y + node.height);
  });

  edges.forEach((edge) => {
    const route = exportRouteForEdge(edge);

    if (!route) {
      return;
    }

    pathPointsFromSvgPath(route.path).forEach((point) => {
      xs.push(point.x);
      ys.push(point.y);
    });

    route.arrowPoints.forEach((point) => {
      xs.push(point.x);
      ys.push(point.y);
    });

    if (edge.label.trim()) {
      const metrics = measureEdgeLabel(edge.label);
      xs.push(route.labelX - metrics.width / 2, route.labelX + metrics.width / 2);
      ys.push(route.labelY - metrics.height / 2, route.labelY + metrics.height / 2);
    }
  });

  if (xs.length === 0 || ys.length === 0) {
    return {
      left: 0,
      top: 0,
      right: EMPTY_GRAPH_WORLD.width,
      bottom: EMPTY_GRAPH_WORLD.height,
      width: EMPTY_GRAPH_WORLD.width,
      height: EMPTY_GRAPH_WORLD.height,
    };
  }

  const left = Math.max(0, Math.floor(Math.min(...xs) - EXPORT_PADDING));
  const top = Math.max(0, Math.floor(Math.min(...ys) - EXPORT_PADDING));
  const right = Math.ceil(Math.max(...xs) + EXPORT_PADDING);
  const bottom = Math.ceil(Math.max(...ys) + EXPORT_PADDING);

  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function exportScale(width: number, height: number) {
  const pixels = width * height;

  if (pixels <= MAX_EXPORT_PIXELS) {
    return 1;
  }

  return Math.sqrt(MAX_EXPORT_PIXELS / pixels);
}

function drawExportBackground(context: CanvasRenderingContext2D, bounds: ReturnType<typeof measureExportBounds>) {
  const styles = exportStyles();
  context.fillStyle = styles.surface;
  context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
  context.strokeStyle = styles.grid;
  context.lineWidth = 1;

  const startX = Math.floor(bounds.left / 24) * 24;
  const startY = Math.floor(bounds.top / 24) * 24;

  for (let x = startX; x <= bounds.right; x += 24) {
    context.beginPath();
    context.moveTo(x, bounds.top);
    context.lineTo(x, bounds.bottom);
    context.stroke();
  }

  for (let y = startY; y <= bounds.bottom; y += 24) {
    context.beginPath();
    context.moveTo(bounds.left, y);
    context.lineTo(bounds.right, y);
    context.stroke();
  }
}

function drawExportEdges(context: CanvasRenderingContext2D) {
  const styles = exportStyles();

  edges.forEach((edge) => {
    const route = exportRouteForEdge(edge);

    if (!route) {
      return;
    }

    context.save();
    context.strokeStyle = styles.edge;
    context.lineWidth = 2.2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke(new Path2D(route.path));
    context.restore();

    if (route.arrowPoints.length > 0) {
      context.save();
      context.fillStyle = styles.edge;
      context.beginPath();
      route.arrowPoints.forEach((point, index) => {
        if (index === 0) {
          context.moveTo(point.x, point.y);
          return;
        }

        context.lineTo(point.x, point.y);
      });
      context.closePath();
      context.fill();
      context.restore();
    }
  });

  edges.forEach((edge) => {
    const route = exportRouteForEdge(edge);

    if (!route) {
      return;
    }

    const label = edge.label.trim();

    if (!label) {
      return;
    }

    const metrics = measureEdgeLabel(label);
    const x = route.labelX - metrics.width / 2;
    const y = route.labelY - metrics.height / 2;
    context.save();
    context.fillStyle = styles.edgeLabelSurface;
    context.strokeStyle = styles.outlineVariant;
    context.lineWidth = 1;
    roundedRect(context, x, y, metrics.width, metrics.height, 6);
    context.fill();
    context.stroke();
    context.fillStyle = styles.textVariant;
    context.font = exportFont(12, 500);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, route.labelX, route.labelY + 1, metrics.width - 16);
    context.restore();
  });
}

function drawExportNodes(context: CanvasRenderingContext2D) {
  const styles = exportStyles();
  const analysis = analyzeGraph();
  const roots = new Set(analysis.roots.map((node) => node.id));
  const leaves = new Set(analysis.leaves.map((node) => node.id));

  [...nodes].sort(compareNodesByPosition).forEach((node) => {
    const nodeColorValue = nodeColor(node);
    const nodeSurface = mixCssColors(nodeColorValue, styles.nodeSurfaceTint, styles.surfaceLowest);
    const borderColor = mixCssColors(nodeColorValue, 0.24, styles.outlineVariant);
    const role = roots.has(node.id) ? "Root" : leaves.has(node.id) ? "Leaf" : "Linked";
    const incoming = incomingEdges(node.id).length;
    const outgoing = outgoingEdges(node.id).length;

    context.save();
    context.shadowColor = styles.shadow;
    context.shadowBlur = 10;
    context.shadowOffsetY = 2;
    context.fillStyle = nodeSurface;
    roundedRect(context, node.x, node.y, node.width, node.height, 8);
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = borderColor;
    context.lineWidth = 1;
    context.stroke();

    context.beginPath();
    roundedRect(context, node.x, node.y, node.width, node.height, 8);
    context.clip();

    drawExportNodeTopline(context, node, role, nodeColorValue, styles);
    drawExportNodeBody(context, node, styles);
    drawExportNodeFooter(context, node, incoming, outgoing, styles);
    context.restore();
  });
}

function drawExportNodeTopline(
  context: CanvasRenderingContext2D,
  node: PuzzleNode,
  role: string,
  nodeColorValue: string,
  styles: ReturnType<typeof exportStyles>,
) {
  const x = node.x + 12;
  const y = node.y + 13;

  context.save();
  context.fillStyle = nodeColorValue;
  context.strokeStyle = styles.swatchBorder;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(x + 9, y + 9, 8, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.fillStyle = styles.textVariant;
  context.font = exportFont(11, 500);
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(labelForKind(node.kind), x + 27, y + 9, Math.max(0, node.width - 96));
  context.textAlign = "right";
  context.fillText(role, node.x + node.width - 12, y + 9, 56);
  context.restore();
}

function drawExportNodeBody(context: CanvasRenderingContext2D, node: PuzzleNode, styles: ReturnType<typeof exportStyles>) {
  const contentX = node.x + 12;
  const contentWidth = node.width - 24;
  context.save();
  context.fillStyle = styles.text;
  context.font = exportFont(14, 700);
  context.textAlign = "left";
  context.textBaseline = "top";
  const titleLines = drawWrappedText(context, node.title, contentX, node.y + 40, contentWidth, 17, 2);

  context.fillStyle = styles.textVariant;
  context.font = exportFont(11, 400);
  const noteY = node.y + 42 + titleLines * 17;
  const footerTop = node.y + node.height - 35;
  const availableNoteLines = Math.max(0, Math.floor((footerTop - noteY - 4) / 14));

  if (availableNoteLines > 0) {
    drawWrappedText(context, node.note, contentX, noteY, contentWidth, 14, availableNoteLines);
  }
  context.restore();
}

function drawExportNodeFooter(
  context: CanvasRenderingContext2D,
  node: PuzzleNode,
  incoming: number,
  outgoing: number,
  styles: ReturnType<typeof exportStyles>,
) {
  const y = node.y + node.height - 28;

  context.save();
  context.strokeStyle = styles.outlineVariant;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(node.x + 12, node.y + node.height - 35);
  context.lineTo(node.x + node.width - 12, node.y + node.height - 35);
  context.stroke();

  context.fillStyle = styles.textVariant;
  context.font = exportFont(11, 500);
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.fillText(`${incoming} in`, node.x + 12, y);
  context.textAlign = "center";
  context.fillText(`${outgoing} out`, node.x + node.width / 2, y);

  if (typeof node.difficulty === "number") {
    context.textAlign = "right";
    context.fillText(`Difficulty ${node.difficulty}`, node.x + node.width - 12, y);
  }

  context.restore();
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const words = text.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0 || maxLines <= 0) {
    return 0;
  }

  const lines: string[] = [];
  let currentLine = "";

  words.forEach((word) => {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (context.measureText(candidate).width <= maxWidth || !currentLine) {
      currentLine = candidate;
      return;
    }

    lines.push(currentLine);
    currentLine = word;
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  lines.slice(0, maxLines).forEach((line, index) => {
    const isLastVisibleLine = index === maxLines - 1 && lines.length > maxLines;
    const output = isLastVisibleLine ? ellipsizeText(context, line, maxWidth) : line;
    context.fillText(output, x, y + index * lineHeight, maxWidth);
  });

  return Math.min(lines.length, maxLines);
}

function ellipsizeText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) {
    return text;
  }

  let output = text;

  while (output.length > 0 && context.measureText(`${output}...`).width > maxWidth) {
    output = output.slice(0, -1);
  }

  return `${output.trimEnd()}...`;
}

function exportRouteForEdge(edge: DependencyEdge): GraphvizEdgeLayout | null {
  const graphvizRoute = graphvizLayout?.edges.get(edge.id);

  if (graphvizRoute) {
    return graphvizRoute;
  }

  const from = getNode(edge.from);
  const to = getNode(edge.to);

  if (!from || !to) {
    return null;
  }

  const start = { x: from.x + from.width, y: from.y + from.height / 2 };
  const end = { x: to.x, y: to.y + to.height / 2 };

  return {
    path: `M ${round(start.x)} ${round(start.y)} L ${round(end.x)} ${round(end.y)}`,
    arrowPoints: arrowForLine(start, end),
    labelX: (start.x + end.x) / 2,
    labelY: (start.y + end.y) / 2,
  };
}

function arrowForLine(start: Point, end: Point) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const size = 12;
  const wing = 5.4;
  const back = {
    x: end.x - Math.cos(angle) * size,
    y: end.y - Math.sin(angle) * size,
  };
  const perpendicular = angle + Math.PI / 2;

  return [
    end,
    {
      x: back.x + Math.cos(perpendicular) * wing,
      y: back.y + Math.sin(perpendicular) * wing,
    },
    {
      x: back.x - Math.cos(perpendicular) * wing,
      y: back.y - Math.sin(perpendicular) * wing,
    },
  ];
}

function pathPointsFromSvgPath(path: string) {
  const values = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const points: Point[] = [];

  for (let index = 0; index + 1 < values.length; index += 2) {
    points.push({ x: values[index], y: values[index + 1] });
  }

  return points;
}

function exportStyles() {
  return {
    edge: cssVar("--edge-color"),
    edgeLabelSurface: cssVar("--edge-label-surface"),
    grid: cssVar("--canvas-space-grid"),
    outlineVariant: cssVar("--md-outline-variant"),
    shadow: document.documentElement.dataset.theme === "dark" ? "rgba(0, 0, 0, 0.45)" : "rgba(25, 28, 29, 0.18)",
    surface: cssVar("--md-surface"),
    surfaceLowest: cssVar("--md-surface-container-lowest"),
    swatchBorder: cssVar("--swatch-border"),
    text: cssVar("--md-on-surface"),
    textVariant: cssVar("--md-on-surface-variant"),
    nodeSurfaceTint: parseCssPercent(cssVar("--node-surface-tint"), 0.12),
  };
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function parseCssPercent(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return value.includes("%") ? parsed / 100 : parsed;
}

function mixCssColors(foreground: string, foregroundAmount: number, background: string) {
  const fg = parseCssColor(foreground);
  const bg = parseCssColor(background);
  const amount = clamp(foregroundAmount, 0, 1);
  const inverse = 1 - amount;

  return `rgba(${Math.round(fg.r * amount + bg.r * inverse)}, ${Math.round(fg.g * amount + bg.g * inverse)}, ${Math.round(fg.b * amount + bg.b * inverse)}, ${round(fg.a * amount + bg.a * inverse)})`;
}

function parseCssColor(value: string) {
  const color = value.trim();
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);

  if (hex) {
    const raw = hex[1].length === 3 ? hex[1].replace(/./g, (part) => `${part}${part}`) : hex[1];

    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgb = color.match(/^rgba?\((.+)\)$/i);

  if (rgb) {
    const parts = rgb[1].split(/[\s,\/]+/).filter(Boolean);
    const [red = "0", green = "0", blue = "0", alpha = "1"] = parts;

    return {
      r: parseCssColorChannel(red),
      g: parseCssColorChannel(green),
      b: parseCssColorChannel(blue),
      a: clamp(Number.parseFloat(alpha), 0, 1),
    };
  }

  return { r: 255, g: 255, b: 255, a: 1 };
}

function parseCssColorChannel(value: string) {
  if (value.endsWith("%")) {
    return clamp((Number.parseFloat(value) / 100) * 255, 0, 255);
  }

  return clamp(Number.parseFloat(value), 0, 255);
}

function exportFont(size: number, weight: number) {
  return `${weight} ${size}px Roboto, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Unable to create export file."));
          return;
        }

        resolve(blob);
      },
      type,
      quality,
    );
  });
}

async function canvasToPdfBlob(canvas: HTMLCanvasElement) {
  const jpegBlob = await canvasToBlob(canvas, "image/jpeg", 0.92);
  return singleImagePdfBlob(new Uint8Array(await jpegBlob.arrayBuffer()), canvas.width, canvas.height);
}

function singleImagePdfBlob(jpegBytes: Uint8Array, imageWidth: number, imageHeight: number) {
  const pageWidth = round(imageWidth * 0.75);
  const pageHeight = round(imageHeight * 0.75);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [0];
  let byteLength = 0;

  const pushBytes = (bytes: Uint8Array) => {
    parts.push(bytes);
    byteLength += bytes.length;
  };
  const pushAscii = (text: string) => pushBytes(encoder.encode(text));
  const startObject = (id: number) => {
    offsets[id] = byteLength;
    pushAscii(`${id} 0 obj\n`);
  };
  const endObject = () => pushAscii("endobj\n");
  const addObject = (id: number, body: string) => {
    startObject(id);
    pushAscii(body);
    endObject();
  };

  pushAscii("%PDF-1.4\n");
  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>\n");
  addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n");
  addObject(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\n`,
  );

  startObject(4);
  pushAscii(
    `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
  );
  pushBytes(jpegBytes);
  pushAscii("\nendstream\n");
  endObject();

  const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
  addObject(5, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\n`);

  const xrefOffset = byteLength;
  pushAscii("xref\n0 6\n0000000000 65535 f \n");

  for (let id = 1; id <= 5; id += 1) {
    pushAscii(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }

  pushAscii(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(parts, { type: "application/pdf" });
}

function blobForExportFormat(canvas: HTMLCanvasElement, format: ExportFormat) {
  if (format === "png") {
    return canvasToBlob(canvas, "image/png");
  }

  if (format === "jpg") {
    return canvasToBlob(canvas, "image/jpeg", 0.92);
  }

  return canvasToPdfBlob(canvas);
}

function isTauriRuntime() {
  return isTauri();
}

function extensionForExportFormat(format: ExportFormat) {
  return format === "pdf" ? "pdf" : format;
}

function acceptedExtensionsForExportFormat(format: ExportFormat) {
  return format === "jpg" ? ["jpg", "jpeg"] : [extensionForExportFormat(format)];
}

function filterForExportFormat(format: ExportFormat) {
  if (format === "png") {
    return { name: "PNG Image", extensions: ["png"] };
  }

  if (format === "jpg") {
    return { name: "JPEG Image", extensions: ["jpg", "jpeg"] };
  }

  return { name: "PDF Document", extensions: ["pdf"] };
}

function ensureFileExtension(path: string, extension: string, acceptedExtensions = [extension]) {
  const normalized = path.toLowerCase();

  if (acceptedExtensions.some((candidate) => normalized.endsWith(`.${candidate.toLowerCase()}`))) {
    return path;
  }

  return `${path}.${extension}`;
}

function filePathDisplayName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function graphFilename(title: string, sourceName: string, extension: string) {
  return `${graphFilenameBase(title, sourceName)}.${extension}`;
}

function graphFilenameBase(title: string, sourceName: string) {
  const candidate = sourceName && sourceName !== "Unsaved graph" ? sourceName : title;
  const withoutExtension = candidate
    .replace(/\.depdoodle\.json$/i, "")
    .replace(/\.depdoodle$/i, "")
    .replace(/\.json$/i, "");
  const sanitized = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();

  return sanitized || "untitled-graph";
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === "png" || value === "jpg" || value === "pdf";
}

function autoArrange() {
  if (graphviz) {
    applyGraphvizAutoLayout();
    return;
  }

  const topology = getTopology();
  const layerMap = topology.layerByNode;
  const layers = topology.layers.length > 0 ? topology.layers : [nodes];
  const xGap = 292;
  const yGap = 152;

  nodes = nodes.map((node) => {
    const layer = layerMap.get(node.id) ?? 0;
    const layerNodes = layers[layer] ?? [node];
    const index = layerNodes.findIndex((layerNode) => layerNode.id === node.id);

    return {
      ...node,
      x: 94 + layer * xGap,
      y: 126 + Math.max(index, 0) * yGap,
    };
  });

  selectedEdgeId = null;
  canvasScroll.scrollLeft = 0;
  canvasScroll.scrollTop = 0;
  render();
}

function applyGraphvizAutoLayout() {
  let layout: GraphvizLayout;

  try {
    layout = computeGraphvizLayout("auto");
    graphvizError = null;
  } catch (error) {
    graphvizError = error instanceof Error ? error.message : "Unknown layout failure";
    refreshGraphvizRouting();
    render();
    return;
  }

  nodes = nodes.map((node) => {
    const nodeLayout = layout.nodes.get(node.id);

    if (!nodeLayout) {
      return node;
    }

    return {
      ...node,
      x: nodeLayout.x,
      y: nodeLayout.y,
    };
  });

  graphvizLayout = layout;
  graphvizRoutingDirty = false;
  selectedEdgeId = null;
  canvasScroll.scrollLeft = 0;
  canvasScroll.scrollTop = 0;
  render();
}

function deleteSelection() {
  if (selectedNodeId) {
    const nodeId = selectedNodeId;
    const affectsRouting = isRoutedNode(nodeId);
    nodes = nodes.filter((node) => node.id !== nodeId);
    edges = edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    selectedNodeId = null;
    if (affectsRouting) {
      markGraphvizRoutingDirty();
    }
    render();
    return;
  }

  if (selectedEdgeId) {
    const edgeId = selectedEdgeId;
    edges = edges.filter((edge) => edge.id !== edgeId);
    selectedEdgeId = null;
    markGraphvizRoutingDirty();
    render();
  }
}

function render() {
  renderAppMode();

  if (!currentGraph) {
    renderWelcome();
    hydrateIcons();
    return;
  }

  refreshGraphvizRoutingIfNeeded();
  const analysis = analyzeGraph();

  renderToolbar();
  renderEdges();
  renderNodes();
  renderMetrics(analysis);
  renderWidthBars(analysis);
  renderWarnings(analysis);
  renderInspector();
  hydrateIcons();
}

function renderAppMode() {
  const isWelcome = !currentGraph;
  appShell.classList.toggle("is-welcome", isWelcome);
  welcomeScreen.hidden = !isWelcome;
  workbench.hidden = isWelcome;
}

function renderWelcome() {
  if (recentGraphs.length === 0) {
    recentList.innerHTML = `
      <p class="recent-empty">No recent graphs yet. Start a new graph or load a graph file.</p>
    `;
    return;
  }

  recentList.innerHTML = recentGraphs
    .map(
      (recent) => `
        <button class="recent-item" type="button" data-recent-id="${escapeAttribute(recent.id)}">
          <strong>${escapeHtml(recent.title)}</strong>
          <span>${escapeHtml(recent.sourceName)}</span>
        </button>
      `,
    )
    .join("");

  recentList.querySelectorAll<HTMLButtonElement>(".recent-item").forEach((button) => {
    button.addEventListener("click", () => {
      const recent = recentGraphs.find((candidate) => candidate.id === button.dataset.recentId);

      if (!recent) {
        return;
      }

      openGraphDocument(recent.document, recent.sourceName, false, recent.filePath);
      rememberGraph(recent.document, recent.sourceName, recent.filePath);
    });
  });
}

function renderToolbar() {
  for (const tool of ["select", "node", "connect"] as Tool[]) {
    const button = must<HTMLButtonElement>(`#tool-${tool}`);
    button.classList.toggle("active", activeTool === tool);
  }

  layoutActionLabel.textContent = "Auto Layout";
  autoLayoutButton.title = "Rearrange nodes by dependency layers";
}

function renderNodes() {
  const analysis = analyzeGraph();
  const roots = new Set(analysis.roots.map((node) => node.id));
  const leaves = new Set(analysis.leaves.map((node) => node.id));

  nodeLayer.innerHTML = nodes
    .map((node) => {
      const incoming = incomingEdges(node.id).length;
      const outgoing = outgoingEdges(node.id).length;
      const selected = node.id === selectedNodeId ? " selected" : "";
      const pending = node.id === pendingConnectionFrom ? " pending-connect" : "";
      const role = roots.has(node.id) ? "Root" : leaves.has(node.id) ? "Leaf" : "Linked";
      const difficultyMarkup =
        typeof node.difficulty === "number" ? `<span>Difficulty ${node.difficulty}</span>` : "";

      return `
        <article
          class="node node-${node.kind}${selected}${pending}"
          data-node-id="${escapeHtml(node.id)}"
          style="left: ${node.x}px; top: ${node.y}px; width: ${node.width}px; height: ${node.height}px; --node-color: ${nodeColor(node)};"
        >
          <div class="node-topline">
            <span class="kind-swatch" aria-hidden="true"></span>
            <span>${escapeHtml(labelForKind(node.kind))}</span>
            <span class="node-role">${role}</span>
          </div>
          <h3>${escapeHtml(node.title)}</h3>
          <p>${escapeHtml(node.note)}</p>
          <div class="node-footer">
            <span>${incoming} in</span>
            <span>${outgoing} out</span>
            ${difficultyMarkup}
          </div>
        </article>
      `;
    })
    .join("");

  nodeLayer.querySelectorAll<HTMLElement>(".node").forEach((element) => {
    element.addEventListener("pointerdown", (event) => {
      const nodeId = element.dataset.nodeId;

      if (!nodeId) {
        return;
      }

      event.stopPropagation();
      handleNodePointerDown(event, nodeId);
    });
  });

  renderNodeGhost();
}

function renderNodeGhost() {
  const existingGhost = nodeLayer.querySelector<HTMLElement>(".node-placement-ghost");

  if (activeTool !== "node" || !nodeGhostPosition) {
    existingGhost?.remove();
    return;
  }

  const ghost =
    existingGhost ??
    (() => {
      const element = document.createElement("article");
      element.className = "node node-placement-ghost";
      element.setAttribute("aria-hidden", "true");
      nodeLayer.appendChild(element);
      return element;
    })();

  ghost.style.left = `${nodeGhostPosition.x}px`;
  ghost.style.top = `${nodeGhostPosition.y}px`;
  ghost.style.width = "210px";
  ghost.style.height = "118px";
  ghost.innerHTML = `
    <div class="node-topline">
      <span class="kind-swatch" aria-hidden="true"></span>
      <span>Puzzle</span>
      <span class="node-role">New</span>
    </div>
    <h3>New puzzle</h3>
    <p>Click to place this node.</p>
    <div class="node-footer">
      <span>0 in</span>
      <span>0 out</span>
    </div>
  `;
}

function renderEdges() {
  const edgeMarkup = edges
    .map((edge) => {
      const route = graphvizLayout?.edges.get(edge.id);

      if (!route) {
        return "";
      }

      const selected = edge.id === selectedEdgeId ? " selected" : "";
      const rawLabel = edge.label.trim();
      const label = escapeHtml(rawLabel);
      const labelMetrics = measureEdgeLabel(rawLabel);
      const labelMarkup = rawLabel
        ? `
          <rect class="edge-label-bg edge-pick" data-edge-id="${escapeHtml(edge.id)}" x="${route.labelX - labelMetrics.width / 2}" y="${route.labelY - labelMetrics.height / 2}" width="${labelMetrics.width}" height="${labelMetrics.height}" rx="6"></rect>
          <text class="edge-label edge-pick" data-edge-id="${escapeHtml(edge.id)}" x="${route.labelX}" y="${route.labelY + 4}">${label}</text>
        `
        : "";
      const arrowPoints = route.arrowPoints
        .map((point) => `${round(point.x)},${round(point.y)}`)
        .join(" ");
      const arrow = arrowPoints ? `<polygon class="edge-arrow" points="${arrowPoints}"></polygon>` : "";

      return `
        <g class="edge-group${selected}" data-edge-id="${escapeHtml(edge.id)}">
          <path class="edge-path" d="${route.path}"></path>
          ${arrow}
          <path class="edge-hit edge-pick" d="${route.path}" data-edge-id="${escapeHtml(edge.id)}"></path>
          ${labelMarkup}
        </g>
      `;
    })
    .join("");

  edgeLayer.innerHTML = edgeMarkup;

  edgeLayer.querySelectorAll<SVGElement>(".edge-pick").forEach((target) => {
    target.addEventListener("pointerdown", (event) => {
      const edgeId = target.dataset.edgeId;

      if (!edgeId) {
        return;
      }

      event.stopPropagation();
      selectedEdgeId = edgeId;
      selectedNodeId = null;
      pendingConnectionFrom = null;
      render();
    });
  });
}

function renderMetrics(analysis: GraphAnalysis) {
  metricGrid.innerHTML = `
    <div class="metric">
      <strong>${nodes.length}</strong>
      <span>Nodes</span>
    </div>
    <div class="metric">
      <strong>${edges.length}</strong>
      <span>Dependencies</span>
    </div>
    <div class="metric">
      <strong>${analysis.roots.length}</strong>
      <span>Roots</span>
    </div>
    <div class="metric">
      <strong>${analysis.bottlenecks.length}</strong>
      <span>Closers</span>
    </div>
  `;
}

function renderWidthBars(analysis: GraphAnalysis) {
  const maxWidth = Math.max(analysis.maxLayerWidth, 1);

  widthBars.innerHTML = analysis.topology.layers
    .map((layer, index) => {
      const percent = (layer.length / maxWidth) * 100;

      return `
        <div class="width-row">
          <span>L${index + 1}</span>
          <div class="width-track">
            <div class="width-fill" style="width: ${percent}%"></div>
          </div>
          <strong>${layer.length}</strong>
        </div>
      `;
    })
    .join("");
}

function renderWarnings(analysis: GraphAnalysis) {
  if (analysis.warnings.length === 0) {
    warningsPanel.innerHTML = `<p class="empty-state">No structural warnings in this chart.</p>`;
    return;
  }

  warningsPanel.innerHTML = analysis.warnings
    .map((warning) => `<p class="warning-item">${escapeHtml(warning)}</p>`)
    .join("");
}

function renderInspector() {
  const selectedNode = selectedNodeId ? getNode(selectedNodeId) : null;
  const selectedEdge = selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) : null;

  if (selectedNode) {
    const prerequisites = incomingEdges(selectedNode.id)
      .map((edge) => getNode(edge.from)?.title ?? edge.from)
      .join(", ");
    const unlocks = outgoingEdges(selectedNode.id)
      .map((edge) => getNode(edge.to)?.title ?? edge.to)
      .join(", ");
    const safeFacts = getAncestors(selectedNode.id).map((node) => node.title);

    inspector.innerHTML = `
      <div class="field-group">
        <label for="node-title">Title</label>
        <input id="node-title" value="${escapeAttribute(selectedNode.title)}" />
      </div>
      <div class="field-row">
        <div class="field-group">
          <label for="node-kind">Kind</label>
          <select id="node-kind">
            ${renderKindOptions(selectedNode.kind)}
          </select>
        </div>
        <div class="field-group compact">
          <label for="node-difficulty">Difficulty</label>
          <input id="node-difficulty" type="number" min="1" max="5" value="${selectedNode.difficulty ?? ""}" placeholder="None" />
        </div>
      </div>
      <div class="field-group">
        <label for="node-color">Color</label>
        <div class="color-control">
          <input id="node-color" type="color" value="${escapeAttribute(nodeColor(selectedNode))}" />
          <span id="node-color-value">${escapeHtml(nodeColor(selectedNode).toUpperCase())}</span>
        </div>
      </div>
      <div class="field-group">
        <label for="node-note">Memo</label>
        <textarea id="node-note">${escapeHtml(selectedNode.note)}</textarea>
      </div>
      <div class="relationship-list">
        <h3>Prerequisites</h3>
        <p>${escapeHtml(prerequisites || "Available at chart start.")}</p>
        <h3>Unlocks</h3>
        <p>${escapeHtml(unlocks || "No downstream puzzle yet.")}</p>
        <h3>Safe narrative context</h3>
        <p>${escapeHtml(safeFacts.length > 0 ? safeFacts.join(", ") : "Only always-known facts are guaranteed.")}</p>
      </div>
      <button class="danger-button" id="delete-selection" type="button">
        <i data-lucide="trash-2"></i>
        <span>Delete Node</span>
      </button>
    `;

    bindNodeInspector(selectedNode.id);
    return;
  }

  if (selectedEdge) {
    inspector.innerHTML = `
      <div class="field-group">
        <label for="edge-label">Dependency Token</label>
        <input id="edge-label" value="${escapeAttribute(selectedEdge.label)}" placeholder="No visible label" />
      </div>
      <div class="field-group">
        <label for="edge-token-type">Token Type</label>
        <select id="edge-token-type">
          ${renderTokenOptions(selectedEdge.tokenType)}
        </select>
      </div>
      <div class="relationship-list">
        <h3>From</h3>
        <p>${escapeHtml(getNode(selectedEdge.from)?.title ?? selectedEdge.from)}</p>
        <h3>To</h3>
        <p>${escapeHtml(getNode(selectedEdge.to)?.title ?? selectedEdge.to)}</p>
      </div>
      <button class="danger-button" id="delete-selection" type="button">
        <i data-lucide="trash-2"></i>
        <span>Delete Edge</span>
      </button>
    `;

    bindEdgeInspector(selectedEdge.id);
    return;
  }

  inspector.innerHTML = `
    <div class="inspector-empty">
      <i data-lucide="mouse-pointer-2"></i>
      <p>Select a puzzle node or dependency arrow to edit its chart semantics.</p>
    </div>
  `;
}

function bindNodeInspector(nodeId: string) {
  must<HTMLInputElement>("#node-title").addEventListener("input", (event) => {
    updateNode(nodeId, { title: (event.target as HTMLInputElement).value });
    renderNodes();
    renderEdges();
  });

  must<HTMLSelectElement>("#node-kind").addEventListener("change", (event) => {
    updateNode(nodeId, { kind: (event.target as HTMLSelectElement).value as NodeKind });
    render();
  });

  must<HTMLInputElement>("#node-color").addEventListener("input", (event) => {
    const color = sanitizeColor((event.target as HTMLInputElement).value);
    updateNode(nodeId, { color });
    must<HTMLSpanElement>("#node-color-value").textContent = color.toUpperCase();
    renderNodes();
  });

  must<HTMLInputElement>("#node-difficulty").addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value.trim();
    const difficulty = value === "" ? undefined : clamp(Number(value), 1, 5);
    updateNode(nodeId, { difficulty });
    renderNodes();
  });

  must<HTMLTextAreaElement>("#node-note").addEventListener("input", (event) => {
    updateNode(nodeId, { note: (event.target as HTMLTextAreaElement).value });
    renderNodes();
  });

  must<HTMLButtonElement>("#delete-selection").addEventListener("click", () => {
    deleteSelection();
  });
}

function bindEdgeInspector(edgeId: string) {
  must<HTMLInputElement>("#edge-label").addEventListener("input", (event) => {
    updateEdge(edgeId, { label: (event.target as HTMLInputElement).value });
    markGraphvizRoutingDirty();
    refreshGraphvizRoutingIfNeeded();
    renderEdges();
  });

  must<HTMLSelectElement>("#edge-token-type").addEventListener("change", (event) => {
    updateEdge(edgeId, {
      tokenType: (event.target as HTMLSelectElement).value as DependencyEdge["tokenType"],
    });
    render();
  });

  must<HTMLButtonElement>("#delete-selection").addEventListener("click", () => {
    deleteSelection();
  });
}

function handleNodePointerDown(event: PointerEvent, nodeId: string) {
  if (activeTool === "connect") {
    if (!pendingConnectionFrom) {
      pendingConnectionFrom = nodeId;
      selectedNodeId = nodeId;
      selectedEdgeId = null;
      render();
      return;
    }

    addDependency(pendingConnectionFrom, nodeId);
    return;
  }

  selectedNodeId = nodeId;
  selectedEdgeId = null;
  pendingConnectionFrom = null;

  const node = getNode(nodeId);

  if (!node) {
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);

  dragState = {
    nodeId,
    offsetX: point.x - node.x,
    offsetY: point.y - node.y,
  };

  window.addEventListener("pointermove", handleDragMove);
  window.addEventListener("pointerup", finishDrag, { once: true });
  render();
}

function handleDragMove(event: PointerEvent) {
  if (!dragState) {
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);

  updateNode(dragState.nodeId, {
    x: clamp(point.x - dragState.offsetX, 30, world.width - 250),
    y: clamp(point.y - dragState.offsetY, 42, world.height - 150),
  });

  if (isRoutedNode(dragState.nodeId)) {
    markGraphvizRoutingDirty();
    refreshGraphvizRoutingIfNeeded();
  }
  renderEdges();
  renderNodes();
}

function finishDrag() {
  dragState = null;
  window.removeEventListener("pointermove", handleDragMove);
  render();
}

function updateNode(nodeId: string, patch: Partial<PuzzleNode>) {
  nodes = nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node));
}

function updateEdge(edgeId: string, patch: Partial<DependencyEdge>) {
  edges = edges.map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge));
}

function getRoutedNodeIds() {
  const routedNodeIds = new Set<string>();

  edges.forEach((edge) => {
    routedNodeIds.add(edge.from);
    routedNodeIds.add(edge.to);
  });

  return routedNodeIds;
}

function isRoutedNode(nodeId: string) {
  return edges.some((edge) => edge.from === nodeId || edge.to === nodeId);
}

async function initializeGraphviz() {
  try {
    graphviz = await Graphviz.load();
    graphvizError = null;
    refreshGraphvizRouting();
    render();
  } catch (error) {
    graphviz = null;
    graphvizLayout = null;
    graphvizError = error instanceof Error ? error.message : "Unknown Graphviz load failure";
    render();
  }
}

function markGraphvizRoutingDirty() {
  graphvizRoutingDirty = true;
}

function refreshGraphvizRoutingIfNeeded() {
  if (!graphvizRoutingDirty) {
    return;
  }

  refreshGraphvizRouting();
}

function refreshGraphvizRouting() {
  if (!graphviz) {
    return;
  }

  try {
    graphvizLayout = computeGraphvizLayout("fixed");
    graphvizError = null;
  } catch (error) {
    graphvizLayout = null;
    graphvizError = error instanceof Error ? error.message : "Unknown routing failure";
  } finally {
    graphvizRoutingDirty = false;
  }
}

function measureEdgeLabel(label: string) {
  if (!edgeLabelMeasureContext) {
    edgeLabelMeasureContext = document.createElement("canvas").getContext("2d");
  }

  const fallbackWidth = label.length * 7.2;
  let textWidth = fallbackWidth;

  if (edgeLabelMeasureContext) {
    edgeLabelMeasureContext.font =
      '12px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    textWidth = edgeLabelMeasureContext.measureText(label).width;
  }

  return {
    width: clamp(Math.ceil(textWidth + EDGE_LABEL_HORIZONTAL_PADDING), EDGE_LABEL_MIN_WIDTH, EDGE_LABEL_MAX_WIDTH),
    height: EDGE_LABEL_HEIGHT,
  };
}

function widestEdgeLabelWidth() {
  if (edges.length === 0) {
    return EDGE_LABEL_MIN_WIDTH;
  }

  return Math.max(...edges.map((edge) => measureEdgeLabel(edge.label).width));
}

function computeGraphvizLayout(mode: "auto" | "fixed"): GraphvizLayout {
  if (!graphviz) {
    throw new Error("Graphviz is not loaded");
  }

  const dot = buildGraphvizDot(mode);
  const output = graphviz.layout(dot, "json", mode === "auto" ? "dot" : "nop2", {
    yInvert: mode === "auto",
  });
  const parsed = JSON.parse(output) as GraphvizJson;
  const raw = parseGraphvizJson(parsed);

  if (mode === "auto") {
    return translateGraphvizLayout(raw, { x: 64, y: 64 });
  }

  const offset = averageFixedLayoutOffset(raw);
  return translateGraphvizLayout(raw, offset);
}

function buildGraphvizDot(mode: "auto" | "fixed") {
  const widestLabel = widestEdgeLabelWidth();
  const topology = getTopology();
  const widestLayer = Math.max(1, ...topology.layers.map((layer) => layer.length));
  const edgeDensity = nodes.length > 0 ? edges.length / nodes.length : 0;
  const autoNodeSep = round(
    clamp(MIN_AUTO_NODESEP + Math.max(0, widestLayer - 4) * 0.11 + edgeDensity * 0.18, MIN_AUTO_NODESEP, 3),
  );
  const autoRankSep = round(clamp(Math.max(MIN_AUTO_RANKSEP, (widestLabel + EDGE_LABEL_SIDE_GUTTER) / 96), MIN_AUTO_RANKSEP, 4.8));
  const graphAttrs =
    mode === "auto"
      ? [
          `rankdir="LR"`,
          `splines="ortho"`,
          `outputorder="edgesfirst"`,
          `forcelabels="true"`,
          `mclimit="2"`,
          `remincross="true"`,
          `searchsize="500"`,
          `nodesep="${autoNodeSep}"`,
          `ranksep="${autoRankSep}"`,
          `pad="0.35"`,
          `margin="0"`,
        ]
      : [`splines="ortho"`, `outputorder="edgesfirst"`, `pad="0.35"`, `margin="0"`];

  const routedNodeIds = mode === "fixed" ? getRoutedNodeIds() : new Set(nodes.map((node) => node.id));
  const graphvizNodes = nodes.filter((node) => routedNodeIds.has(node.id));
  const nodeLines = graphvizNodes
    .map((node) => {
      const attrs = [
        `label=""`,
        `shape="box"`,
        `fixedsize="true"`,
        `width="${round(node.width / GRAPHVIZ_POINTS_PER_INCH)}"`,
        `height="${round(node.height / GRAPHVIZ_POINTS_PER_INCH)}"`,
        `margin="0"`,
      ];

      if (mode === "fixed") {
        attrs.push(`pos="${round(node.x + node.width / 2)},${round(node.y + node.height / 2)}!"`);
      }

      return `  ${dotId(node.id)} [${attrs.join(", ")}];`;
    })
    .join("\n");

  const edgeLines = edges
    .map((edge) => {
      const attrs = [
        `edgeId=${dotId(edge.id)}`,
        `label=""`,
        `arrowsize="0.7"`,
        `penwidth="1.8"`,
        `fontsize="12"`,
        `fontname="Inter"`,
      ];

      return `  ${dotId(edge.from)} -> ${dotId(edge.to)} [${attrs.join(", ")}];`;
    })
    .join("\n");

  return `digraph DepDoodle {
  graph [${graphAttrs.join(", ")}];
  node [shape="box", fixedsize="true", margin="0"];
  edge [color="#5f7780", fontcolor="#485059"];
${nodeLines}
${edgeLines}
}`;
}

function parseGraphvizJson(json: GraphvizJson): GraphvizLayout {
  const nodesById = new Map<string, PuzzleNode>(nodes.map((node) => [node.id, node]));
  const graphSize = parseGraphvizBounds(json.bb);
  const parsedNodes = new Map<string, GraphvizNodeLayout>();
  const parsedEdges = new Map<string, GraphvizEdgeLayout>();
  const edgeGeometries: Array<{
    edgeId: string;
    pathPoints: Point[];
    arrowPoints: Point[];
    labelPoint: Point;
  }> = [];

  for (const object of json.objects ?? []) {
    const node = nodesById.get(object.name);
    const center = object.pos ? parseGraphvizPoint(object.pos) : null;

    if (!node || !center) {
      continue;
    }

    parsedNodes.set(node.id, {
      center,
      x: center.x - node.width / 2,
      y: center.y - node.height / 2,
      width: node.width,
      height: node.height,
    });
  }

  for (const graphvizEdge of json.edges ?? []) {
    const edgeId = graphvizEdge.edgeId;

    if (!edgeId) {
      continue;
    }

    const pathPoints = findDrawPoints(graphvizEdge._draw_, "b");
    const arrowPoints = findDrawPoints(graphvizEdge._hdraw_, "P");

    if (!pathPoints || pathPoints.length === 0) {
      continue;
    }

    edgeGeometries.push({
      edgeId,
      pathPoints,
      arrowPoints: arrowPoints ?? [],
      labelPoint: midpoint(pathPoints),
    });
  }

  const edgeObstacleRectsByEdge = new Map(
    edgeGeometries.map((geometry) => [geometry.edgeId, edgePathObstacleRects(geometry.pathPoints)]),
  );
  const placedLabelRects: Rect[] = [];

  for (const geometry of edgeGeometries) {
    const otherEdgeObstacleRects = edgeGeometries
      .filter((candidate) => candidate.edgeId !== geometry.edgeId)
      .flatMap((candidate) => edgeObstacleRectsByEdge.get(candidate.edgeId) ?? []);
    const labelPoint = fitLabelPoint(
      geometry.edgeId,
      geometry.labelPoint,
      geometry.pathPoints,
      parsedNodes,
      otherEdgeObstacleRects,
      placedLabelRects,
    );
    const sourceEdge = edges.find((edge) => edge.id === geometry.edgeId);
    const label = sourceEdge?.label.trim() ?? "";

    if (label) {
      placedLabelRects.push(inflateRect(labelRect(labelPoint, measureEdgeLabel(label)), EDGE_LABEL_CLEARANCE));
    }

    parsedEdges.set(geometry.edgeId, {
      path: bezierPath(geometry.pathPoints),
      arrowPoints: geometry.arrowPoints,
      labelX: labelPoint.x,
      labelY: labelPoint.y,
    });
  }

  return {
    width: graphSize.width,
    height: graphSize.height,
    nodes: parsedNodes,
    edges: parsedEdges,
  };
}

function fitLabelPoint(
  edgeId: string,
  defaultPoint: Point,
  pathPoints: Point[],
  layoutNodes: Map<string, GraphvizNodeLayout>,
  edgeObstacleRects: Rect[],
  placedLabelRects: Rect[],
) {
  const sourceEdge = edges.find((edge) => edge.id === edgeId);
  const label = sourceEdge?.label.trim() ?? "";
  const labelMetrics = measureEdgeLabel(label);

  if (!label) {
    return defaultPoint;
  }

  const nodeRects = [...layoutNodes.values()].map((node) =>
    inflateRect(
      {
        left: node.x,
        top: node.y,
        right: node.x + node.width,
        bottom: node.y + node.height,
      },
      10,
    ),
  );
  const pathCandidates = labelPathCandidates(pathPoints);
  const anchorPoint = midpoint(pathCandidates);

  return labelCandidates(defaultPoint, pathCandidates)
    .map((point) => ({
      point,
      score: labelPlacementScore(
        point,
        labelMetrics,
        anchorPoint,
        pathCandidates,
        nodeRects,
        edgeObstacleRects,
        placedLabelRects,
      ),
      distance: distanceBetween(point, anchorPoint),
    }))
    .sort((a, b) => a.score - b.score || a.distance - b.distance)[0]?.point ?? defaultPoint;
}

function labelPathCandidates(pathPoints: Point[]) {
  const candidates = [midpoint(pathPoints)];

  for (let index = 1; index + 2 < pathPoints.length; index += 3) {
    const start = pathPoints[index - 1];
    const controlA = pathPoints[index];
    const controlB = pathPoints[index + 1];
    const end = pathPoints[index + 2];

    for (const t of [0.18, 0.32, 0.5, 0.68, 0.82]) {
      candidates.push(cubicPoint(start, controlA, controlB, end, t));
    }
  }

  return uniquePoints(candidates);
}

function labelCandidates(defaultPoint: Point, pathCandidates: Point[]) {
  return uniquePoints([defaultPoint, ...pathCandidates]);
}

function labelPlacementScore(
  point: Point,
  metrics: { width: number; height: number },
  anchorPoint: Point,
  pathCandidates: Point[],
  nodeRects: Rect[],
  edgeObstacleRects: Rect[],
  placedLabelRects: Rect[],
) {
  const rect = labelRect(point, metrics);
  const inflatedRect = inflateRect(rect, EDGE_LABEL_CLEARANCE);
  const routeDistance = nearestPointDistance(point, pathCandidates);
  const nodeOverlap = nodeRects.reduce((sum, nodeRect) => sum + intersectionArea(inflatedRect, nodeRect), 0);
  const labelOverlap = placedLabelRects.reduce((sum, labelObstacle) => sum + intersectionArea(inflatedRect, labelObstacle), 0);
  const edgeOverlap = edgeObstacleRects.reduce((sum, edgeRect) => sum + intersectionArea(rect, edgeRect), 0);

  return (
    nodeOverlap * 80 +
    labelOverlap * 50 +
    edgeOverlap * 8 +
    routeDistance * 400 +
    distanceBetween(point, anchorPoint) * 0.8
  );
}

function edgePathObstacleRects(pathPoints: Point[]) {
  const rects: Rect[] = [];

  for (let index = 0; index < pathPoints.length - 1; index += 1) {
    const start = pathPoints[index];
    const end = pathPoints[index + 1];

    rects.push({
      left: Math.min(start.x, end.x) - EDGE_ROUTE_CLEARANCE,
      top: Math.min(start.y, end.y) - EDGE_ROUTE_CLEARANCE,
      right: Math.max(start.x, end.x) + EDGE_ROUTE_CLEARANCE,
      bottom: Math.max(start.y, end.y) + EDGE_ROUTE_CLEARANCE,
    });
  }

  return rects;
}

function edgeLabelAttachmentReport() {
  refreshGraphvizRoutingIfNeeded();

  return edges
    .filter((edge) => edge.label.trim())
    .map((edge) => {
      const route = graphvizLayout?.edges.get(edge.id);

      if (!route) {
        return {
          attached: false,
          distance: Number.POSITIVE_INFINITY,
          edgeId: edge.id,
          label: edge.label,
          labelX: null,
          labelY: null,
        };
      }

      const labelPoint = { x: route.labelX, y: route.labelY };
      const routePoints = pathPointsFromSvgPath(route.path);
      const distance = nearestPointDistance(labelPoint, labelPathCandidates(routePoints));

      return {
        attached: distance <= 2,
        distance: round(distance),
        edgeId: edge.id,
        label: edge.label,
        labelX: round(route.labelX),
        labelY: round(route.labelY),
      };
    });
}

function labelRect(point: Point, metrics: { width: number; height: number }): Rect {
  return {
    left: point.x - metrics.width / 2,
    top: point.y - metrics.height / 2,
    right: point.x + metrics.width / 2,
    bottom: point.y + metrics.height / 2,
  };
}

function inflateRect(rect: Rect, amount: number): Rect {
  return {
    left: rect.left - amount,
    top: rect.top - amount,
    right: rect.right + amount,
    bottom: rect.bottom + amount,
  };
}

function intersectionArea(a: Rect, b: Rect) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

  return width * height;
}

function translateGraphvizLayout(layout: GraphvizLayout, offset: Point): GraphvizLayout {
  const translatedNodes = new Map<string, GraphvizNodeLayout>();
  const translatedEdges = new Map<string, GraphvizEdgeLayout>();

  for (const [nodeId, node] of layout.nodes) {
    translatedNodes.set(nodeId, {
      ...node,
      center: translatePoint(node.center, offset),
      x: node.x + offset.x,
      y: node.y + offset.y,
    });
  }

  for (const [edgeId, edge] of layout.edges) {
    translatedEdges.set(edgeId, {
      path: translatePath(edge.path, offset),
      arrowPoints: edge.arrowPoints.map((point) => translatePoint(point, offset)),
      labelX: edge.labelX + offset.x,
      labelY: edge.labelY + offset.y,
    });
  }

  const measured = measureWorldSize(translatedNodes, translatedEdges);
  resizeWorld(measured.width, measured.height);

  return {
    width: measured.width,
    height: measured.height,
    nodes: translatedNodes,
    edges: translatedEdges,
  };
}

function averageFixedLayoutOffset(layout: GraphvizLayout): Point {
  const deltas = [...layout.nodes.entries()]
    .map(([nodeId, nodeLayout]) => {
      const node = getNode(nodeId);

      if (!node) {
        return null;
      }

      return {
        x: node.x + node.width / 2 - nodeLayout.center.x,
        y: node.y + node.height / 2 - nodeLayout.center.y,
      };
    })
    .filter((delta): delta is Point => delta !== null);

  if (deltas.length === 0) {
    return { x: 0, y: 0 };
  }

  return {
    x: deltas.reduce((sum, delta) => sum + delta.x, 0) / deltas.length,
    y: deltas.reduce((sum, delta) => sum + delta.y, 0) / deltas.length,
  };
}

function measureWorldSize(
  layoutNodes: Map<string, GraphvizNodeLayout>,
  layoutEdges: Map<string, GraphvizEdgeLayout>,
) {
  const xs: number[] = [1680];
  const ys: number[] = [1040];

  nodes.forEach((node) => {
    xs.push(node.x + node.width + 220);
    ys.push(node.y + node.height + 220);
  });

  layoutNodes.forEach((node) => {
    xs.push(node.x + node.width + 220);
    ys.push(node.y + node.height + 220);
  });

  layoutEdges.forEach((edge, edgeId) => {
    edge.arrowPoints.forEach((point) => {
      xs.push(point.x + 220);
      ys.push(point.y + 220);
    });
    const sourceEdge = edges.find((candidate) => candidate.id === edgeId);
    const labelMetrics = measureEdgeLabel(sourceEdge?.label ?? "");
    xs.push(edge.labelX + labelMetrics.width / 2 + 220);
    ys.push(edge.labelY + labelMetrics.height / 2 + 220);
  });

  return {
    width: Math.ceil(Math.max(...xs)),
    height: Math.ceil(Math.max(...ys)),
  };
}

function setZoom(nextZoom: number, anchor?: { clientX: number; clientY: number }) {
  const previousZoom = zoom;
  const next = roundZoom(clamp(nextZoom, MIN_ZOOM, MAX_ZOOM));

  if (next === previousZoom) {
    return;
  }

  const scrollRect = canvasScroll.getBoundingClientRect();
  const anchorX = anchor ? anchor.clientX - scrollRect.left : canvasScroll.clientWidth / 2;
  const anchorY = anchor ? anchor.clientY - scrollRect.top : canvasScroll.clientHeight / 2;
  const worldX = (canvasScroll.scrollLeft + anchorX) / previousZoom;
  const worldY = (canvasScroll.scrollTop + anchorY) / previousZoom;

  zoom = next;
  applyZoom();

  canvasScroll.scrollLeft = worldX * zoom - anchorX;
  canvasScroll.scrollTop = worldY * zoom - anchorY;

  if (activeTool === "node") {
    nodeGhostPosition = null;
    renderNodeGhost();
  }
}

function fitGraphToView() {
  const widthFit = (canvasScroll.clientWidth - 48) / world.width;
  const heightFit = (canvasScroll.clientHeight - 48) / world.height;

  zoom = roundZoom(clamp(Math.min(widthFit, heightFit, 1), MIN_ZOOM, MAX_ZOOM));
  applyZoom();
  canvasScroll.scrollLeft = 0;
  canvasScroll.scrollTop = 0;

  if (activeTool === "node") {
    nodeGhostPosition = null;
    renderNodeGhost();
  }
}

function applyZoom() {
  graphViewport.style.width = `${Math.ceil(world.width * zoom)}px`;
  graphViewport.style.height = `${Math.ceil(world.height * zoom)}px`;
  graphSpace.style.transform = `scale(${zoom})`;
  zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  zoomOutButton.disabled = zoom <= MIN_ZOOM + 0.001;
  zoomInButton.disabled = zoom >= MAX_ZOOM - 0.001;
}

function resizeWorld(width: number, height: number) {
  world = {
    width,
    height,
  };
  graphSpace.style.width = `${world.width}px`;
  graphSpace.style.height = `${world.height}px`;
  applyZoom();
  edgeLayer.setAttribute("width", `${world.width}`);
  edgeLayer.setAttribute("height", `${world.height}`);
  edgeLayer.setAttribute("viewBox", `0 0 ${world.width} ${world.height}`);
}

function findDrawPoints(ops: GraphvizDrawOp[] | undefined, op: string) {
  const drawOp = ops?.find((candidate) => candidate.op === op && candidate.points);

  if (!drawOp?.points) {
    return null;
  }

  return drawOp.points.map(([x, y]) => ({ x, y }));
}

function parseGraphvizBounds(bounds: string | undefined) {
  if (!bounds) {
    return { width: world.width, height: world.height };
  }

  const [x1, y1, x2, y2] = bounds.split(",").map(Number);

  return {
    width: Math.abs((x2 ?? world.width) - (x1 ?? 0)),
    height: Math.abs((y2 ?? world.height) - (y1 ?? 0)),
  };
}

function parseGraphvizPoint(value: string): Point {
  const [x, y] = value.split(",").map(Number);

  return {
    x: x ?? 0,
    y: y ?? 0,
  };
}

function midpoint(points: Point[]): Point {
  return points[Math.floor(points.length / 2)] ?? { x: 0, y: 0 };
}

function cubicPoint(start: Point, controlA: Point, controlB: Point, end: Point, t: number): Point {
  const inverse = 1 - t;

  return {
    x:
      inverse ** 3 * start.x +
      3 * inverse ** 2 * t * controlA.x +
      3 * inverse * t ** 2 * controlB.x +
      t ** 3 * end.x,
    y:
      inverse ** 3 * start.y +
      3 * inverse ** 2 * t * controlA.y +
      3 * inverse * t ** 2 * controlB.y +
      t ** 3 * end.y,
  };
}

function uniquePoints(points: Point[]) {
  const seen = new Set<string>();

  return points.filter((point) => {
    const key = `${round(point.x)},${round(point.y)}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function distanceBetween(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nearestPointDistance(point: Point, candidates: Point[]) {
  if (candidates.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.min(...candidates.map((candidate) => distanceBetween(point, candidate)));
}

function bezierPath(points: Point[]) {
  if (points.length === 0) {
    return "";
  }

  const commands = [`M ${round(points[0].x)} ${round(points[0].y)}`];

  for (let index = 1; index + 2 < points.length; index += 3) {
    const a = points[index];
    const b = points[index + 1];
    const c = points[index + 2];
    commands.push(
      `C ${round(a.x)} ${round(a.y)} ${round(b.x)} ${round(b.y)} ${round(c.x)} ${round(c.y)}`,
    );
  }

  return commands.join(" ");
}

function translatePoint(point: Point, offset: Point): Point {
  return {
    x: point.x + offset.x,
    y: point.y + offset.y,
  };
}

function translatePath(path: string, offset: Point) {
  return path.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => {
    return `${round(Number(x) + offset.x)} ${round(Number(y) + offset.y)}`;
  });
}

function dotId(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function analyzeGraph(): GraphAnalysis {
  const topology = getTopology();
  const roots = nodes.filter((node) => incomingEdges(node.id).length === 0);
  const leaves = nodes.filter((node) => outgoingEdges(node.id).length === 0);
  const bottlenecks = nodes.filter((node) => incomingEdges(node.id).length >= 2);
  const warnings: string[] = [];
  const maxLayerWidth = topology.layers.reduce((max, layer) => Math.max(max, layer.length), 0);
  const danglingLeaves = leaves.filter((node) => node.kind !== "reward");

  if (topology.hasCycle) {
    warnings.push("Cycle detected. Puzzle dependency charts should normally be acyclic.");
  }

  if (roots.length === 0 && nodes.length > 0) {
    warnings.push("No root nodes. The player may have no starting puzzle.");
  }

  if (danglingLeaves.length > 0) {
    warnings.push(`Non-reward leaves: ${danglingLeaves.map((node) => node.title).join(", ")}.`);
  }

  if (maxLayerWidth > 5) {
    warnings.push(`Layer width ${maxLayerWidth} may create heavy authoring and test debt.`);
  }

  if (bottlenecks.length === 0 && nodes.length > 3) {
    warnings.push("No closers yet. Consider where branches intentionally collapse.");
  }

  if (graphvizError) {
    warnings.push(`Graphviz routing error: ${graphvizError}`);
  }

  return {
    roots,
    leaves,
    bottlenecks,
    warnings,
    topology,
    maxLayerWidth,
  };
}

function getTopology(): Topology {
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  nodes.forEach((node) => {
    inDegree.set(node.id, 0);
    children.set(node.id, []);
  });

  edges.forEach((edge) => {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  });

  const queue = nodes
    .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
    .sort(compareNodesByPosition);
  const order: PuzzleNode[] = [];

  while (queue.length > 0) {
    const node = queue.shift();

    if (!node) {
      continue;
    }

    order.push(node);

    for (const childId of children.get(node.id) ?? []) {
      const nextDegree = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, nextDegree);

      if (nextDegree === 0) {
        const child = getNode(childId);

        if (child) {
          queue.push(child);
          queue.sort(compareNodesByPosition);
        }
      }
    }
  }

  const hasCycle = order.length !== nodes.length;
  const orderedNodes = hasCycle ? [...nodes].sort(compareNodesByPosition) : order;
  const layerByNode = new Map<string, number>();

  orderedNodes.forEach((node) => {
    const parentLayers = incomingEdges(node.id)
      .map((edge) => layerByNode.get(edge.from))
      .filter((layer): layer is number => typeof layer === "number");
    const layer = parentLayers.length === 0 ? 0 : Math.max(...parentLayers) + 1;
    layerByNode.set(node.id, layer);
  });

  const layers: PuzzleNode[][] = [];

  for (const node of orderedNodes) {
    const layer = layerByNode.get(node.id) ?? 0;

    if (!layers[layer]) {
      layers[layer] = [];
    }

    layers[layer].push(node);
  }

  return {
    hasCycle,
    order: orderedNodes,
    layerByNode,
    layers,
  };
}

function getAncestors(nodeId: string) {
  const visited = new Set<string>();
  const result: PuzzleNode[] = [];
  const stack = incomingEdges(nodeId).map((edge) => edge.from);

  while (stack.length > 0) {
    const currentId = stack.pop();

    if (!currentId || visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);
    const node = getNode(currentId);

    if (node) {
      result.push(node);
    }

    incomingEdges(currentId).forEach((edge) => stack.push(edge.from));
  }

  return result.sort(compareNodesByPosition);
}

function getNode(nodeId: string) {
  return nodes.find((node) => node.id === nodeId);
}

function incomingEdges(nodeId: string) {
  return edges.filter((edge) => edge.to === nodeId);
}

function outgoingEdges(nodeId: string) {
  return edges.filter((edge) => edge.from === nodeId);
}

function getCanvasPoint(clientX: number, clientY: number) {
  const rect = graphSpace.getBoundingClientRect();

  return {
    x: (clientX - rect.left) / zoom,
    y: (clientY - rect.top) / zoom,
  };
}

function clampNodePosition(x: number, y: number): Point {
  return {
    x: clamp(x, 40, world.width - 260),
    y: clamp(y, 60, world.height - 180),
  };
}

function normalizeGraphDocument(value: unknown): GraphDocumentV1 {
  const record = asRecord(value, "Graph file must be an object.");

  if (record.format !== "depdoodle.graph" || record.version !== 1) {
    throw new Error("Unsupported graph format. Expected depdoodle.graph version 1.");
  }

  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    throw new Error("Graph file must include nodes and edges arrays.");
  }

  const normalizedNodes = record.nodes.map((node) => normalizeGraphNode(node));
  const nodeIds = new Set(normalizedNodes.map((node) => node.id));
  const normalizedEdges = record.edges
    .map((edge) => normalizeGraphEdge(edge))
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const worldRecord = isRecord(record.world) ? record.world : {};

  return {
    format: "depdoodle.graph",
    version: 1,
    title: stringValue(record.title, "Untitled Graph"),
    description: optionalString(record.description),
    world: {
      width: optionalPositiveNumber(worldRecord.width),
      height: optionalPositiveNumber(worldRecord.height),
    },
    nodes: normalizedNodes,
    edges: normalizedEdges,
  };
}

function normalizeGraphNode(value: unknown): PuzzleNode {
  const record = asRecord(value, "Graph node must be an object.");
  const id = stringValue(record.id, "");

  if (!id) {
    throw new Error("Graph node is missing an id.");
  }

  const kind = isNodeKind(record.kind) ? record.kind : "puzzle";
  const act = stringValue(record.act, "Act I");
  const difficulty = optionalDifficulty(record.difficulty);

  return {
    id,
    title: stringValue(record.title, "Untitled puzzle"),
    note: stringValue(record.note, ""),
    kind,
    color: sanitizeColor(stringValue(record.color, defaultNodeColor(kind, act))),
    act,
    difficulty,
    x: finiteNumber(record.x, 80),
    y: finiteNumber(record.y, 80),
    width: clamp(finiteNumber(record.width, 220), 160, 420),
    height: clamp(finiteNumber(record.height, 104), 84, 220),
  };
}

function normalizeGraphEdge(value: unknown): DependencyEdge {
  const record = asRecord(value, "Graph edge must be an object.");
  const id = stringValue(record.id, "");
  const from = stringValue(record.from, "");
  const to = stringValue(record.to, "");

  if (!id || !from || !to) {
    throw new Error("Graph edge is missing an id, from, or to value.");
  }

  return {
    id,
    from,
    to,
    label: stringValue(record.label, ""),
    tokenType: isTokenType(record.tokenType) ? record.tokenType : "item",
  };
}

function rememberGraph(document: GraphDocumentV1, sourceName: string, filePath?: string) {
  const openedAt = new Date().toISOString();
  const id = recentGraphId(document.title, filePath ?? sourceName);
  recentGraphs = [
    {
      id,
      title: document.title,
      sourceName,
      openedAt,
      document: cloneGraphDocument(document),
      filePath,
    },
    ...recentGraphs.filter((recent) => recent.id !== id),
  ].slice(0, 8);
  saveRecentGraphs();
}

function loadRecentGraphs(): RecentGraph[] {
  try {
    const raw = localStorage.getItem(RECENT_GRAPHS_STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => {
        if (!isRecord(value)) {
          return null;
        }

        try {
          const document = normalizeGraphDocument(value.document);
          const title = stringValue(value.title, document.title);
          const sourceName = stringValue(value.sourceName, "Recent graph");
          const filePath = optionalString(value.filePath);

          if (sourceName === "Bundled sample") {
            return null;
          }

          const recent: RecentGraph = {
            id: stringValue(value.id, recentGraphId(title, filePath ?? sourceName)),
            title,
            sourceName,
            openedAt: stringValue(value.openedAt, ""),
            document,
          };

          if (filePath) {
            recent.filePath = filePath;
          }

          return recent;
        } catch {
          return null;
        }
      })
      .filter((recent): recent is RecentGraph => recent !== null);
  } catch {
    return [];
  }
}

function loadThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);

    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // Theme persistence is optional; use the system preference if storage is unavailable.
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function setTheme(nextTheme: ThemeMode) {
  themeMode = nextTheme;

  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  } catch {
    // The toggle still works for this session if local storage is unavailable.
  }

  applyTheme(themeMode);
}

function applyTheme(nextTheme: ThemeMode) {
  document.documentElement.dataset.theme = nextTheme;
  themeToggle.setAttribute("aria-pressed", String(nextTheme === "dark"));
  themeToggle.title = nextTheme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  themeToggle.setAttribute("aria-label", themeToggle.title);
  themeLabel.textContent = nextTheme === "dark" ? "Dark" : "Light";
}

function saveRecentGraphs() {
  try {
    localStorage.setItem(RECENT_GRAPHS_STORAGE_KEY, JSON.stringify(recentGraphs));
  } catch {
    // Recent files are a convenience; the graph should still open if storage is unavailable.
  }
}

function cloneGraphDocument(document: GraphDocumentV1): GraphDocumentV1 {
  return JSON.parse(JSON.stringify(document)) as GraphDocumentV1;
}

function recentGraphId(title: string, sourceName: string) {
  return `${sourceName}::${title}`.toLowerCase();
}

function measureGraphBounds(graphNodes: PuzzleNode[]) {
  return {
    width: Math.ceil(Math.max(...graphNodes.map((node) => node.x + node.width + 220), EMPTY_GRAPH_WORLD.width)),
    height: Math.ceil(Math.max(...graphNodes.map((node) => node.y + node.height + 220), EMPTY_GRAPH_WORLD.height)),
  };
}

function nextSerial(ids: string[], prefix: string) {
  const max = ids.reduce((highest, id) => {
    if (!id.startsWith(prefix)) {
      return highest;
    }

    const parsed = Number(id.slice(prefix.length));
    return Number.isFinite(parsed) ? Math.max(highest, parsed) : highest;
  }, 0);

  return max + 1;
}

function asRecord(value: unknown, message = "Expected an object."): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalPositiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalDifficulty(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), 1, 5) : undefined;
}

function isNodeKind(value: unknown): value is NodeKind {
  return value === "puzzle" || value === "gate" || value === "reward";
}

function isTokenType(value: unknown): value is DependencyEdge["tokenType"] {
  return value === "item" || value === "access" || value === "fact" || value === "state" || value === "permission";
}

function defaultNodeColor(kind: NodeKind, act = "") {
  if (act === "Laverne") {
    return "#008d00";
  }

  if (act === "Bernard") {
    return "#6395dc";
  }

  if (act === "Hoagie") {
    return "#f19c49";
  }

  if (act === "Beginning / Ending") {
    return "#d72a15";
  }

  const colors: Record<NodeKind, string> = {
    puzzle: "#549aa3",
    gate: "#c18b2c",
    reward: "#7f6699",
  };

  return colors[kind];
}

function nodeColor(node: PuzzleNode) {
  return sanitizeColor(node.color || defaultNodeColor(node.kind, node.act));
}

function sanitizeColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#549aa3";
}

function renderKindOptions(selected: NodeKind) {
  return (["puzzle", "gate", "reward"] as NodeKind[])
    .map(
      (kind) =>
        `<option value="${kind}" ${kind === selected ? "selected" : ""}>${labelForKind(kind)}</option>`,
    )
    .join("");
}

function renderTokenOptions(selected: DependencyEdge["tokenType"]) {
  return (["item", "access", "fact", "state", "permission"] as DependencyEdge["tokenType"][])
    .map(
      (token) =>
        `<option value="${token}" ${token === selected ? "selected" : ""}>${labelForToken(token)}</option>`,
    )
    .join("");
}

function labelForKind(kind: NodeKind) {
  const labels: Record<NodeKind, string> = {
    puzzle: "Puzzle",
    gate: "Gate",
    reward: "Reward",
  };

  return labels[kind];
}

function labelForToken(token: DependencyEdge["tokenType"]) {
  const labels: Record<DependencyEdge["tokenType"], string> = {
    item: "Item",
    access: "Access",
    fact: "Fact",
    state: "State",
    permission: "Permission",
  };

  return labels[token];
}

function compareNodesByPosition(a: PuzzleNode, b: PuzzleNode) {
  if (a.x === b.x) {
    return a.y - b.y;
  }

  return a.x - b.x;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function roundZoom(value: number) {
  return Math.round(value * 100) / 100;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function hydrateIcons() {
  createIcons({
    icons: {
      Activity,
      Download,
      FilePlus2,
      FolderOpen,
      GitBranchPlus,
      History,
      House,
      Layers3,
      Maximize2,
      Moon,
      MousePointer2,
      PanelRight,
      Save,
      SquarePlus,
      Sun,
      Trash2,
      TriangleAlert,
      Workflow,
      ZoomIn,
      ZoomOut,
    },
    attrs: {
      "aria-hidden": "true",
      width: 17,
      height: 17,
      "stroke-width": 2,
    },
  });
}

function installDebugApi() {
  if (!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
    return;
  }

  window.__depdoodleDebug = {
    autoLayout: () => {
      autoArrange();
    },
    labelAttachmentReport: edgeLabelAttachmentReport,
    loadGraph: (document) => {
      openGraphDocument(document, "Debug graph", false);
    },
    waitForGraphviz: async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (graphviz || graphvizError) {
          return;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }

      throw new Error("Graphviz did not finish loading.");
    },
  };
}

render();
installDebugApi();
initializeGraphviz();
