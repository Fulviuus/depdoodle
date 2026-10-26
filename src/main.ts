import {
  Activity,
  createIcons,
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  FolderOpen,
  GitBranchPlus,
  Group as GroupIcon,
  History,
  House,
  Layers3,
  Magnet,
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
  Redo2,
  Undo2,
  Ungroup,
  Workflow,
} from "lucide";
import { loadLayoutEngine, type D2LayoutEngine, type LayoutGeometry, type LayoutMode } from "./layout-engine";
import { isTauri } from "@tauri-apps/api/core";
import { ask, open as showOpenDialog, save as showSaveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";

import { RectangleIndex } from "./spatial-index";
import { DependencyModel } from "./semantics";
import { getCurrentWindow } from "@tauri-apps/api/window";

type NodeKind = "puzzle" | "gate" | "reward";
type Tool = "select" | "node" | "connect";
type ThemeMode = "light" | "dark";
type ExportFormat = "png" | "jpg" | "pdf" | "svg";
type CenterTab = "chart" | "pacing";

interface PuzzleNode {
  id: string;
  title: string;
  note: string;
  kind: NodeKind;
  color: string;
  difficulty?: number;
  prerequisiteMode?: "all" | "any";
  narrativeReferences?: string[];
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
  manualRoute?: Point[];
  manualLabelPosition?: number;
}

interface PuzzleGroup {
  id: string;
  name: string;
  color: string;
  nodeIds: string[];
  hidden: boolean;
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
  groups?: PuzzleGroup[];
}

interface GraphHistorySnapshot {
  world: {
    width: number;
    height: number;
  };
  nodes: PuzzleNode[];
  edges: DependencyEdge[];
  groups: PuzzleGroup[];
  title: string;
  description: string;
  selectedNodeIds: string[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectedGroupId: string | null;
}

interface GraphDiagnostic {
  key: string;
  message: string;
  ids: string[];
}

interface ExportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface RasterExport {
  canvas: HTMLCanvasElement;
  bounds: ExportBounds;
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
  primaryNodeId: string;
  nodeIds: string[];
  startPoint: Point;
  originPositions: Array<{
    nodeId: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  offsetX: number;
  offsetY: number;
}

interface SelectionBoxState {
  start: Point;
  current: Point;
  additive: boolean;
  initialNodeIds: Set<string>;
  hasMoved: boolean;
}

interface GroupDragState {
  groupId: string;
  startPoint: Point;
  originBounds: Rect;
  originPositions: Array<{
    nodeId: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  offsetX: number;
  offsetY: number;
}

type EdgeSegmentOrientation = "horizontal" | "vertical" | "free";

interface EdgeRouteDragState {
  edgeId: string;
  segmentIndex: number;
  orientation: EdgeSegmentOrientation;
  startPoint: Point;
  originalPoints: Point[];
}

interface EdgeLabelDragState {
  edgeId: string;
  originalPosition: number;
  startPointerPosition: number;
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

interface PacingLane {
  id: string;
  name: string;
  color: string;
  nodes: PuzzleNode[];
}

interface PacingBar {
  node: PuzzleNode;
  laneId: string;
  startLayer: number;
  endLayer: number;
  track: number;
  incoming: number;
  outgoing: number;
  role: string;
}

interface RoutedNodeLayout {
  center: Point;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RoutedEdgeLayout {
  path: string;
  arrowPoints: Point[];
  labelX: number;
  labelY: number;
}

interface RoutedLayout {
  width: number;
  height: number;
  nodes: Map<string, RoutedNodeLayout>;
  edges: Map<string, RoutedEdgeLayout>;
}

declare global {
  interface Window {
    __depdoodleDebug?: {
      autoLayout: () => Promise<void>;
      labelAttachmentReport: () => ReturnType<typeof edgeLabelAttachmentReport>;
      loadGraph: (document: GraphDocumentV1) => void;
      waitForRouting: () => Promise<void>;
    };
  }
}

const EDGE_LABEL_MIN_WIDTH = 68;
const EDGE_LABEL_MAX_WIDTH = 320;
const EDGE_LABEL_HEIGHT = 24;
const EDGE_LABEL_HORIZONTAL_PADDING = 24;
const EDGE_LABEL_CLEARANCE = 10;
const EDGE_ROUTE_CLEARANCE = 8;
const GROUP_PADDING_X = 32;
const GROUP_PADDING_TOP = 52;
const GROUP_PADDING_BOTTOM = 32;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.2;
const SNAP_GRID_SIZE = 24;
const EXPORT_PADDING = 56;
const EXPORT_RASTER_SCALE = 2;
const MAX_EXPORT_PIXELS = 96_000_000;
const EXPORT_FONT_FAMILY = 'Roboto, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const AUTO_LAYOUT_CONFIRM_MESSAGE = "Auto Layout will move every node and replace all connector routes and label positions. You can undo it afterward. Continue?";
const REROUTE_CONFIRM_MESSAGE = "Replace the routes and label positions of visible connections? Node positions will stay the same. You can undo it afterward.";
const RECENT_GRAPHS_STORAGE_KEY = "depdoodle.recentGraphs";
const THEME_STORAGE_KEY = "depdoodle.theme";
const SNAP_TO_GRID_STORAGE_KEY = "depdoodle.snapToGrid";
const EMPTY_GRAPH_WORLD = { width: 1680, height: 1040 };
const MAX_HISTORY_DEPTH = 100;
const RECOVERY_STORAGE_KEY = "depdoodle.recovery";
let savedDocumentKey = "";
let documentSession = 0;
let saving = false;
let recoveryTimer: number | null = null;
let recoveryAvailable = true;
let nativeCloseApproved = false;
let closeDecisionPending = false;

let world = {
  ...EMPTY_GRAPH_WORLD,
};

let nodes: PuzzleNode[] = [];
let edges: DependencyEdge[] = [];
let groups: PuzzleGroup[] = [];
let currentGraph: LoadedGraph | null = null;
let recentGraphs: RecentGraph[] = loadRecentGraphs();

let selectedNodeIds = new Set<string>();
let selectedNodeId: string | null = null;
let selectedEdgeId: string | null = null;
let selectedGroupId: string | null = null;
let selectedDiagnosticKeys = new Set<string>();
let diagnosticNodeIds = new Set<string>();
let diagnosticEdgeIds = new Set<string>();
let activeTool: Tool = "select";
let pendingConnectionFrom: string | null = null;
let dragState: DragState | null = null;
let groupDragState: GroupDragState | null = null;
let selectionBoxState: SelectionBoxState | null = null;
let edgeRouteDragState: EdgeRouteDragState | null = null;
let edgeLabelDragState: EdgeLabelDragState | null = null;
let nodeSerial = nodes.length + 1;
let edgeSerial = edges.length + 1;
let groupSerial = groups.length + 1;
let undoStack: GraphHistorySnapshot[] = [];
let redoStack: GraphHistorySnapshot[] = [];
let graphEditBefore: GraphHistorySnapshot | null = null;
let layoutEngine: D2LayoutEngine | null = null;
let layoutEngineLoadPromise: Promise<D2LayoutEngine | null> | null = null;
let layoutActionRunning = false;
let routingError: string | null = null;
let automaticRoutes: RoutedLayout | null = null;
let automaticRoutesDirty = true;
let routingRevision = 0;
let routingContentRevision = 0;
let automaticRoutingPromise: Promise<void> | null = null;
let edgePreviewHandle: number | null = null;
let nodeGhostPosition: Point | null = null;
let edgeLabelMeasureContext: CanvasRenderingContext2D | null = null;
let zoom = 1;
let themeMode: ThemeMode = loadThemeMode();
let snapToGrid = loadSnapToGrid();
let exportMenuOpen = false;
let activeCenterTab: CenterTab = "chart";
let modelNodes: PuzzleNode[] | null = null;
let modelEdges: DependencyEdge[] | null = null;
let cachedModel: DependencyModel;
let focusNodeIds: Set<string> | null = null;
let simulationActive = false;
let completedNodeIds = new Set<string>();

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app mount point");
}

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <button class="tool-button" id="back-to-welcome" type="button" title="Back to welcome screen" aria-label="Back to welcome screen">
          <i data-lucide="house"></i>
          <span>Welcome</span>
        </button>
      </div>
      <nav class="toolbar" aria-label="Chart tools">
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
            <button type="button" role="menuitem" data-export-format="png" title="Export as PNG">PNG</button>
            <button type="button" role="menuitem" data-export-format="jpg" title="Export as JPG">JPG</button>
            <button type="button" role="menuitem" data-export-format="pdf" title="Export as PDF">PDF</button>
            <button type="button" role="menuitem" data-export-format="svg" title="Export as SVG">SVG</button>
          </div>
        </div>
        <span class="toolbar-separator" aria-hidden="true"></span>
        <button class="tool-button icon-tool" id="undo-graph" type="button" title="Undo" aria-label="Undo" disabled>
          <i data-lucide="undo-2"></i>
        </button>
        <button class="tool-button icon-tool" id="redo-graph" type="button" title="Redo" aria-label="Redo" disabled>
          <i data-lucide="redo-2"></i>
        </button>
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
        <button class="tool-button" id="snap-grid" type="button" title="Snap nodes to the grid" aria-pressed="true">
          <i data-lucide="magnet"></i>
          <span>Snap</span>
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
        <div class="welcome-logo">
          <img class="welcome-logo-light" src="/depdoodle-logo.svg" alt="DepDoodle" width="600" height="152" />
          <img class="welcome-logo-dark" src="/depdoodle-logo-dark.svg" alt="DepDoodle" width="600" height="152" />
        </div>
        <h1>Puzzle dependency charts editor</h1>
        <p class="welcome-copy">Create a chart, load a saved <code>.depdoodle</code> graph, or reopen recent work.</p>
        <div class="welcome-actions">
          <button class="secondary-button" id="recover-draft" type="button" hidden>Recover unsaved draft</button>
          <button class="welcome-action primary" id="new-graph" type="button" title="Create a new graph">
            <i data-lucide="file-plus-2"></i>
            <span>New Graph</span>
          </button>
          <button class="welcome-action" id="load-graph" type="button" title="Load a .depdoodle graph">
            <i data-lucide="folder-open"></i>
            <span>Load Graph</span>
          </button>
        </div>
      </section>

      <aside class="recent-sidebar">
        <div class="recent-heading">
          <i data-lucide="history"></i>
          <h2>Recent Files</h2>
          <button class="recent-clear" id="clear-recent" type="button" title="Clear recent files" aria-label="Clear recent files">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
        <div class="recent-list" id="recent-list"></div>
      </aside>
    </main>

    <div class="workbench" id="workbench">
      <aside class="analysis-pane">
        <section class="explorer"><label for="node-search">Find a puzzle</label>
          <input id="node-search" type="search" placeholder="Search titles and memos" />
          <div id="search-results" class="search-results"></div>
          <button id="clear-focus" class="secondary-button" type="button" hidden>Show entire graph</button>
        </section>
        <section><label class="simulation-toggle"><input id="simulate-toggle" type="checkbox" /> Simulate playthrough</label>
          <div id="simulation-panel" hidden></div>
        </section>
        <section>
          <div class="pane-heading">
            <i data-lucide="activity"></i>
            <h2>Structure</h2>
          </div>
          <div class="metric-grid" id="metric-grid"></div>
          <button class="secondary-button reroute-action" id="reroute-graph" type="button" title="Recalculate visible connector routes after confirmation">Reroute connections…</button>
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
        <div class="center-tabs" role="tablist" aria-label="Graph views">
          <button class="center-tab active" id="view-chart" type="button" role="tab" aria-selected="true" aria-controls="chart-panel" title="Show dependency chart">
            <i data-lucide="workflow"></i>
            <span>Chart</span>
          </button>
          <button class="center-tab" id="view-pacing" type="button" role="tab" aria-selected="false" aria-controls="pacing-panel" title="Show pacing analysis">
            <i data-lucide="activity"></i>
            <span>Pacing</span>
          </button>
          <span id="save-status" role="status" aria-live="polite"></span>
        </div>

        <section class="chart-panel" id="chart-panel" role="tabpanel" aria-labelledby="view-chart">
          <div id="focus-banner" class="focus-banner" role="status" hidden>
            <span id="focus-count"></span><button type="button" data-clear-focus>Show entire graph</button>
          </div>
          <div class="canvas-ruler horizontal"></div>
          <div class="canvas-ruler vertical"></div>
          <div class="canvas-scroll" id="canvas-scroll">
            <div class="graph-viewport" id="graph-viewport">
              <div class="graph-space" id="graph-space">
                <div class="group-layer" id="group-layer"></div>
                <svg class="edge-layer" id="edge-layer" width="${world.width}" height="${world.height}" viewBox="0 0 ${world.width} ${world.height}">
                </svg>
                <div class="node-layer" id="node-layer"></div>
              </div>
            </div>
          </div>
        </section>

        <section class="pacing-panel" id="pacing-panel" role="tabpanel" aria-labelledby="view-pacing" hidden>
          <div class="pacing-scroll" id="pacing-scroll">
            <div class="pacing-board" id="pacing-board"></div>
          </div>
        </section>
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
const chartPanel = must<HTMLElement>("#chart-panel");
const pacingPanel = must<HTMLElement>("#pacing-panel");
const pacingBoard = must<HTMLDivElement>("#pacing-board");
const graphSpace = must<HTMLDivElement>("#graph-space");
const graphViewport = must<HTMLDivElement>("#graph-viewport");
const groupLayer = must<HTMLDivElement>("#group-layer");
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
const snapGridButton = must<HTMLButtonElement>("#snap-grid");
const layoutActionLabel = must<HTMLSpanElement>("#layout-action-label");
const zoomLevel = must<HTMLSpanElement>("#zoom-level");
const zoomOutButton = must<HTMLButtonElement>("#zoom-out");
const zoomInButton = must<HTMLButtonElement>("#zoom-in");
const graphFileInput = must<HTMLInputElement>("#graph-file-input");
const recentList = must<HTMLDivElement>("#recent-list");
const exportButton = must<HTMLButtonElement>("#export-graph");
const exportMenu = must<HTMLDivElement>("#export-menu");
const undoButton = must<HTMLButtonElement>("#undo-graph");
const redoButton = must<HTMLButtonElement>("#redo-graph");
const clearRecentButton = must<HTMLButtonElement>("#clear-recent");

resizeWorld(world.width, world.height);
applyTheme(themeMode);

must<HTMLButtonElement>("#new-graph").addEventListener("click", () => {
  void createNewGraph();
});

must<HTMLButtonElement>("#load-graph").addEventListener("click", () => {
  void openGraphFile();
});

graphFileInput.addEventListener("change", () => {
  void handleGraphFileInput();
});

clearRecentButton.addEventListener("click", () => {
  clearRecentGraphs();
});

must<HTMLButtonElement>("#back-to-welcome").addEventListener("click", () => {
  void showWelcomeScreen();
});

must<HTMLButtonElement>("#view-chart").addEventListener("click", () => {
  setCenterTab("chart");
});

must<HTMLButtonElement>("#view-pacing").addEventListener("click", () => {
  setCenterTab("pacing");
});

must<HTMLButtonElement>("#save-graph").addEventListener("click", () => {
  void saveGraph();
});

undoButton.addEventListener("click", () => {
  undoGraphEdit();
});

redoButton.addEventListener("click", () => {
  redoGraphEdit();
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
  void autoArrange();
});

snapGridButton.addEventListener("click", () => {
  setSnapToGrid(!snapToGrid);
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

  nodeGhostPosition = positionNodeForPlacement(point.x - 105, point.y - 58);
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

  if (target.closest(".node") || target.closest(".edge-pick") || target.closest(".group-box")) {
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);

  if (activeTool === "node") {
    const ghostPosition = nodeGhostPosition ?? positionNodeForPlacement(point.x - 105, point.y - 58);
    addNodeAt(ghostPosition.x, ghostPosition.y);
    return;
  }

  if (activeTool === "select") {
    beginSelectionBox(event, point);
    return;
  }

  clearSelection();
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setExportMenuOpen(false);
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) {
      redoGraphEdit();
    } else {
      undoGraphEdit();
    }
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoGraphEdit();
    return;
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
    void autoArrange();
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

function setCenterTab(tab: CenterTab) {
  activeCenterTab = tab;
  render();
}

function isSelectionModifier(event: MouseEvent | PointerEvent) {
  return event.shiftKey || event.metaKey || event.ctrlKey;
}

function selectOnlyNode(nodeId: string) {
  selectedNodeIds = new Set([nodeId]);
  selectedNodeId = nodeId;
  selectedEdgeId = null;
  selectedGroupId = null;
  pendingConnectionFrom = null;
}

function setSelectedNodes(nodeIds: Iterable<string>, primaryNodeId?: string) {
  const knownNodeIds = new Set(nodes.map((node) => node.id));
  selectedNodeIds = new Set([...nodeIds].filter((nodeId) => knownNodeIds.has(nodeId)));
  selectedNodeId =
    primaryNodeId && selectedNodeIds.has(primaryNodeId)
      ? primaryNodeId
      : nodes.find((node) => selectedNodeIds.has(node.id))?.id ?? null;
  selectedGroupId = null;

  if (selectedNodeId) {
    selectedEdgeId = null;
  }
}

function toggleNodeSelection(nodeId: string) {
  const nextSelection = new Set(selectedNodeIds);

  if (nextSelection.has(nodeId)) {
    nextSelection.delete(nodeId);
  } else {
    nextSelection.add(nodeId);
  }

  setSelectedNodes(nextSelection, nextSelection.has(nodeId) ? nodeId : undefined);
}

function selectOnlyEdge(edgeId: string) {
  selectedNodeIds = new Set();
  selectedNodeId = null;
  selectedEdgeId = edgeId;
  selectedGroupId = null;
  pendingConnectionFrom = null;
}

function selectOnlyGroup(groupId: string) {
  selectedNodeIds = new Set();
  selectedNodeId = null;
  selectedEdgeId = null;
  selectedGroupId = groupId;
  pendingConnectionFrom = null;
}

function clearSelection() {
  selectedNodeIds = new Set();
  selectedNodeId = null;
  selectedEdgeId = null;
  selectedGroupId = null;
  pendingConnectionFrom = null;
}

function syncPrimarySelection() {
  if (selectedGroupId) {
    selectedNodeIds = new Set();
    selectedNodeId = null;
    selectedEdgeId = null;
    return;
  }

  setSelectedNodes(selectedNodeIds, selectedNodeId ?? undefined);
}

function captureGraphHistorySnapshot(): GraphHistorySnapshot {
  return {
    world: { ...world },
    nodes: nodes.map((node) => ({ ...node })),
    edges: edges.map(cloneEdge),
    groups: groups.map(cloneGroup),
    title: currentGraph?.title ?? "",
    description: currentGraph?.description ?? "",
    selectedNodeIds: [...selectedNodeIds],
    selectedNodeId,
    selectedEdgeId,
    selectedGroupId,
  };
}

function restoreGraphHistorySnapshot(snapshot: GraphHistorySnapshot) {
  nodes = snapshot.nodes.map((node) => ({ ...node }));
  edges = snapshot.edges.map(cloneEdge);
  groups = snapshot.groups.map(cloneGroup);
  if (currentGraph) {
    currentGraph = {
      ...currentGraph,
      title: snapshot.title,
      description: snapshot.description.trim() ? snapshot.description : undefined,
    };
  }
  selectedNodeIds = new Set(snapshot.selectedNodeIds ?? (snapshot.selectedNodeId ? [snapshot.selectedNodeId] : []));
  selectedNodeId = snapshot.selectedNodeId;
  selectedEdgeId = snapshot.selectedEdgeId;
  selectedGroupId = snapshot.selectedGroupId;
  pendingConnectionFrom = null;
  activeTool = "select";
  nodeGhostPosition = null;
  dragState = null;
  groupDragState = null;
  selectionBoxState = null;
  edgeRouteDragState = null;
  edgeLabelDragState = null;
  cancelScheduledEdgePreview();
  renderSelectionBox();
  syncPrimarySelection();
  if (selectedGroupId && !groups.some((group) => group.id === selectedGroupId)) {
    selectedGroupId = null;
  }
  window.removeEventListener("pointermove", handleEdgeRouteDragMove);
  window.removeEventListener("pointermove", handleEdgeLabelDragMove);
  window.removeEventListener("pointermove", handleGroupDragMove);
  window.removeEventListener("pointerup", finishEdgeRouteDrag);
  window.removeEventListener("pointerup", finishEdgeLabelDrag);
  window.removeEventListener("pointerup", finishGroupDrag);
  nodeSerial = nextSerial(nodes.map((node) => node.id), "n-custom-");
  edgeSerial = nextSerial(edges.map((edge) => edge.id), "e-custom-");
  groupSerial = nextSerial(groups.map((group) => group.id), "g-custom-");
  automaticRoutes = null;
  invalidateAutomaticRoutes();
  resizeWorld(snapshot.world.width, snapshot.world.height);
  render();
  noteGraphChanged();
}

function graphHistoryDataKey(snapshot: GraphHistorySnapshot) {
  return JSON.stringify({
    world: snapshot.world,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    groups: snapshot.groups,
    title: snapshot.title,
    description: snapshot.description,
  });
}

function graphHistoryChanged(before: GraphHistorySnapshot, after: GraphHistorySnapshot) {
  return graphHistoryDataKey(before) !== graphHistoryDataKey(after);
}

function beginGraphEdit() {
  if (!currentGraph || graphEditBefore) {
    return;
  }

  graphEditBefore = captureGraphHistorySnapshot();
}

function commitGraphEdit() {
  if (!graphEditBefore) {
    updateHistoryControls();
    return;
  }

  const before = graphEditBefore;
  graphEditBefore = null;
  const after = captureGraphHistorySnapshot();

  if (graphHistoryChanged(before, after)) {
    undoStack = [...undoStack, before].slice(-MAX_HISTORY_DEPTH);
    redoStack = [];
  }

  updateHistoryControls();
  noteGraphChanged();
}

function resetGraphHistory() {
  undoStack = [];
  redoStack = [];
  graphEditBefore = null;
  updateHistoryControls();
}

function withGraphEdit(action: () => void) {
  beginGraphEdit();
  action();
  commitGraphEdit();
}

function undoGraphEdit() {
  if (!currentGraph) {
    return;
  }

  commitGraphEdit();
  const previous = undoStack.pop();

  if (!previous) {
    updateHistoryControls();
    return;
  }

  redoStack = [...redoStack, captureGraphHistorySnapshot()].slice(-MAX_HISTORY_DEPTH);
  restoreGraphHistorySnapshot(previous);
  updateHistoryControls();
}

function redoGraphEdit() {
  if (!currentGraph) {
    return;
  }

  commitGraphEdit();
  const next = redoStack.pop();

  if (!next) {
    updateHistoryControls();
    return;
  }

  undoStack = [...undoStack, captureGraphHistorySnapshot()].slice(-MAX_HISTORY_DEPTH);
  restoreGraphHistorySnapshot(next);
  updateHistoryControls();
}

function updateHistoryControls() {
  undoButton.disabled = !currentGraph || undoStack.length === 0;
  redoButton.disabled = !currentGraph || redoStack.length === 0;
  undoButton.title = undoButton.disabled ? "Nothing to undo" : "Undo";
  redoButton.title = redoButton.disabled ? "Nothing to redo" : "Redo";
}

function ensureButtonTooltips(root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    if (button.title.trim()) {
      return;
    }

    const label = button.getAttribute("aria-label") ?? button.textContent?.replace(/\s+/g, " ").trim();

    if (label) {
      button.title = label;
    }
  });
}

function addNodeAt(x: number, y: number) {
  withGraphEdit(() => {
    const position = positionNodeForPlacement(x, y);
    const node: PuzzleNode = {
      id: `n-custom-${nodeSerial}`,
      title: `Puzzle ${nodeSerial}`,
      note: "Describe the player action and the dependency token it creates.",
      kind: "puzzle",
      color: defaultNodeColor("puzzle"),
      x: position.x,
      y: position.y,
      width: 210,
      height: 118,
    };

    nodeSerial += 1;
    nodes = [...nodes, node];
    invalidateAutomaticRoutes();
    if (focusNodeIds) focusNodeIds = new Set([...focusNodeIds, node.id]);
    selectOnlyNode(node.id);
    activeTool = "select";
    nodeGhostPosition = null;
    render();
  });
}

function addDependency(from: string, to: string) {
  if (from === to || edges.some((edge) => edge.from === from && edge.to === to)) {
    pendingConnectionFrom = null;
    setTool("select");
    return;
  }

  withGraphEdit(() => {
    const edge: DependencyEdge = {
      id: `e-custom-${edgeSerial}`,
      from,
      to,
      label: "",
      tokenType: "state",
    };

    edgeSerial += 1;
    edges = [...edges, edge];
    invalidateAutomaticRoutes();
    selectOnlyEdge(edge.id);
    pendingConnectionFrom = null;
    activeTool = "select";
    render();
  });
}

async function createNewGraph() {
  if (!(await confirmLeaveGraph())) return;
  clearRecovery();
  openGraphDocument(
    {
      format: "depdoodle.graph",
      version: 1,
      title: "Untitled Graph",
      world: { ...EMPTY_GRAPH_WORLD },
      nodes: [],
      edges: [],
      groups: [],
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
    if (!(await confirmLeaveGraph())) return;
    clearRecovery();
    openGraphDocument(document, file.name);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to load graph file.");
  }
}

function openGraphDocument(document: GraphDocumentV1, sourceName: string, updateRecent = true, filePath?: string) {
  documentSession += 1;
  clearDiagnosticSelection();
  automaticRoutes = null;
  invalidateAutomaticRoutes();
  focusNodeIds = null;
  simulationActive = false;
  completedNodeIds = new Set();
  must<HTMLInputElement>("#simulate-toggle").checked = false;
  must<HTMLInputElement>("#node-search").value = "";
  cancelRecoveryTimer();
  const normalized = normalizeGraphDocument(document);
  nodes = normalized.nodes.map((node) => ({ ...node }));
  edges = normalized.edges.map(cloneEdge);
  groups = (normalized.groups ?? []).map(cloneGroup);
  currentGraph = {
    title: normalized.title,
    sourceName,
    description: normalized.description,
    filePath,
  };
  nodeSerial = nextSerial(nodes.map((node) => node.id), "n-custom-");
  edgeSerial = nextSerial(edges.map((edge) => edge.id), "e-custom-");
  groupSerial = nextSerial(groups.map((group) => group.id), "g-custom-");
  clearSelection();
  activeTool = "select";
  nodeGhostPosition = null;
  selectionBoxState = null;
  renderSelectionBox();
  resetGraphHistory();
  zoom = 1;
  activeCenterTab = "chart";

  const measured = measureGraphBounds(nodes, edges);
  resizeWorld(
    Math.max(normalized.world?.width ?? 0, measured.width, EMPTY_GRAPH_WORLD.width),
    Math.max(normalized.world?.height ?? 0, measured.height, EMPTY_GRAPH_WORLD.height),
  );

  canvasScroll.scrollLeft = 0;
  canvasScroll.scrollTop = 0;

  if (updateRecent) {
    rememberGraph(normalized, sourceName, filePath);
  }

  savedDocumentKey = documentDataKey(createGraphDocument());
  render();
  updateSaveStatus();
}

async function showWelcomeScreen() {
  if (!(await confirmLeaveGraph())) return;
  clearRecovery();
  currentGraph = null;
  clearDiagnosticSelection();
  clearSelection();
  activeTool = "select";
  nodeGhostPosition = null;
  selectionBoxState = null;
  renderSelectionBox();
  resetGraphHistory();
  setExportMenuOpen(false);
  activeCenterTab = "chart";
  render();
}

function documentDataKey(document: GraphDocumentV1) {
  const { world: _world, ...data } = document;
  return JSON.stringify(data);
}

function hasUnsavedChanges() {
  return currentGraph !== null && documentDataKey(createGraphDocument()) !== savedDocumentKey;
}

function cancelRecoveryTimer() {
  if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
  recoveryTimer = null;
}

function noteGraphChanged() {
  if (!currentGraph) return;
  cancelRecoveryTimer();
  recoveryTimer = window.setTimeout(persistRecovery, 300);
  updateSaveStatus();
}

function readRecovery(): { document: GraphDocumentV1; sourceName: string; filePath?: string; savedKey: string } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(RECOVERY_STORAGE_KEY) ?? "null");
    if (!isRecord(raw)) return null;
    return { document: normalizeGraphDocument(raw.document), sourceName: stringValue(raw.sourceName, "Recovered draft"),
      filePath: optionalString(raw.filePath), savedKey: stringValue(raw.savedKey, "") };
  } catch { return null; }
}

function persistRecovery() {
  cancelRecoveryTimer();
  if (!currentGraph) return;
  try {
    if (!hasUnsavedChanges()) localStorage.removeItem(RECOVERY_STORAGE_KEY);
    else localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ document: createGraphDocument(),
      sourceName: currentGraph.sourceName, filePath: currentGraph.filePath, savedKey: savedDocumentKey }));
    recoveryAvailable = true;
  } catch { recoveryAvailable = false; }
  updateSaveStatus();
}

function clearRecovery() {
  cancelRecoveryTimer();
  try { localStorage.removeItem(RECOVERY_STORAGE_KEY); } catch { /* Storage can be disabled. */ }
}

function updateSaveStatus() {
  const status = document.querySelector<HTMLElement>("#save-status");
  if (!status) return;
  status.textContent = !currentGraph ? "" : saving ? "Saving…" : hasUnsavedChanges()
    ? recoveryAvailable ? "Unsaved changes" : "Unsaved · recovery unavailable"
    : currentGraph.sourceName === "Unsaved graph" ? "Unsaved graph" : "Saved";
}

function graphChoice(title: string, message: string, choices: Array<[string, string]>): Promise<string> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "save-dialog";
    dialog.setAttribute("aria-labelledby", "save-prompt-title");
    dialog.innerHTML = `<form method="dialog"><h2 id="save-prompt-title">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p><div class="dialog-actions">${choices.map(([value, label], index) =>
        `<button value="${escapeAttribute(value)}" ${index === 0 ? "autofocus" : ""}>${escapeHtml(label)}</button>`).join("")}</div></form>`;
    dialog.addEventListener("close", () => { const value = dialog.returnValue; dialog.remove(); resolve(value); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function openRecoveryDraft() {
  const recovery = readRecovery();
  if (!recovery) return;
  openGraphDocument(recovery.document, recovery.sourceName, false, recovery.filePath);
  savedDocumentKey = recovery.savedKey;
  noteGraphChanged();
}

async function confirmLeaveGraph() {
  if (!currentGraph && readRecovery()) {
    const choice = await graphChoice("An unsaved draft is available", "Recover your previous work before opening another graph, or discard the draft.",
      [["cancel", "Cancel"], ["discard", "Discard draft"], ["recover", "Recover draft"]]);
    if (choice === "recover") openRecoveryDraft();
    return choice === "discard";
  }
  if (!hasUnsavedChanges()) return true;
  persistRecovery();
  const choice = await graphChoice("Save your changes?", "Your changes have not been saved to a graph file.",
    [["cancel", "Cancel"], ["discard", "Discard changes"], ["save", "Save"]]);
  if (choice === "discard") return true;
  return choice === "save" && await saveGraph() && !hasUnsavedChanges();
}

async function openGraphFile(defaultPath?: string) {
  if (!isTauriRuntime()) { graphFileInput.click(); return; }
  const path = await showOpenDialog({ title: "Open DepDoodle Graph", defaultPath,
    multiple: false, directory: false, filters: [{ name: "DepDoodle", extensions: ["depdoodle", "json"] }] });
  if (typeof path !== "string") return;
  try {
    const graph = normalizeGraphDocument(JSON.parse(await readTextFile(path)));
    if (!(await confirmLeaveGraph())) return;
    clearRecovery();
    openGraphDocument(graph, filePathDisplayName(path), true, path);
  } catch (error) { window.alert(error instanceof Error ? error.message : "Unable to open graph."); }
}

function refreshDerivedViews() {
  if (simulationActive) completedNodeIds = dependencyModel().validCompleted(completedNodeIds);
  const analysis = analyzeGraph();
  renderNodes(analysis);
  renderEdges();
  renderMetrics(analysis);
  renderWidthBars(analysis);
  renderWarnings(analysis);
  if (activeCenterTab === "pacing") renderPacingView(analysis);
  renderExplorer();
  renderSimulation();
}

function setExportMenuOpen(open: boolean) {
  exportMenuOpen = open && currentGraph !== null;
  exportMenu.hidden = !exportMenuOpen;
  exportButton.setAttribute("aria-expanded", String(exportMenuOpen));
}

async function saveGraph(): Promise<boolean> {
  if (!currentGraph || saving) return false;
  commitGraphEdit();
  saving = true;
  const session = documentSession;
  const document = createGraphDocument();
  const key = documentDataKey(document);
  const filename = graphFilename(document.title, currentGraph.sourceName, "depdoodle");
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  try {
    if (isTauriRuntime()) {
      let filePath = currentGraph.filePath;
      if (filePath) {
        try {
          await writeTextFile(filePath, contents);
        } catch {
          // Older recents may predate persisted permissions. Let the user
          // select the destination again to restore access safely.
          filePath = undefined;
        }
      }
      if (!filePath) {
        const selected = await showSaveDialog({
          title: "Save DepDoodle Graph", defaultPath: currentGraph.filePath ?? filename,
          filters: [{ name: "DepDoodle", extensions: ["depdoodle"] }], canCreateDirectories: true,
        });
        if (!selected) return false;
        filePath = selected;
        await writeTextFile(filePath, contents);
      }
      if (session !== documentSession) return false;
      const sourceName = filePathDisplayName(filePath);
      currentGraph = { ...currentGraph!, sourceName, filePath };
      rememberGraph(document, sourceName, filePath);
    } else {
      downloadBlob(new Blob([contents], { type: "application/json" }), filename);
      if (session !== documentSession) return false;
      currentGraph = { ...currentGraph!, sourceName: filename };
      rememberGraph(document, filename);
    }
    savedDocumentKey = key;
    if (!hasUnsavedChanges()) clearRecovery();
    else persistRecovery();
    return true;
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to save graph.");
    return false;
  } finally {
    saving = false;
    updateSaveStatus();
  }
}

async function exportGraph(format: ExportFormat) {
  if (!currentGraph) {
    return;
  }

  try {
    await ensureAutomaticRouting();
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

      const blob = await blobForExportFormat(format);
      await writeFile(
        ensureFileExtension(filePath, extension, acceptedExtensionsForExportFormat(format)),
        new Uint8Array(await blob.arrayBuffer()),
      );
      return;
    }

    downloadBlob(await blobForExportFormat(format), filename);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to export chart.");
  }
}

function createGraphDocument(): GraphDocumentV1 {
  const description = currentGraph?.description?.trim();

  return {
    format: "depdoodle.graph",
    version: 1,
    title: currentGraph?.title.trim() || "Untitled Graph",
    ...(description ? { description } : {}),
    world: { ...world },
    nodes: nodes.map((node) => ({ ...node })),
    edges: edges.map(cloneEdge),
    groups: groups.map(cloneGroup),
  };
}

function renderGraphToCanvas(): RasterExport {
  refreshAutomaticRoutesIfNeeded();

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
  context.translate(-bounds.left, -bounds.top);
  drawExportBackground(context, bounds);
  drawExportGroups(context);
  drawExportEdges(context);
  drawExportNodes(context);

  return { canvas, bounds };
}

function measureExportBounds(): ExportBounds {
  const xs: number[] = [];
  const ys: number[] = [];

  visibleNodes().forEach((node) => {
    xs.push(node.x, node.x + node.width);
    ys.push(node.y, node.y + node.height);
  });

  groups.forEach((group) => {
    const bounds = groupBounds(group);

    if (!bounds) {
      return;
    }

    xs.push(bounds.left, bounds.right);
    ys.push(bounds.top, bounds.bottom);
  });

  visibleEdges().forEach((edge) => {
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

  const left = Math.max(0, Math.floor(minOf(xs, 0) - EXPORT_PADDING));
  const top = Math.max(0, Math.floor(minOf(ys, 0) - EXPORT_PADDING));
  const right = Math.ceil(maxOf(xs, 0) + EXPORT_PADDING);
  const bottom = Math.ceil(maxOf(ys, 0) + EXPORT_PADDING);

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
  const maxScale = Math.sqrt(MAX_EXPORT_PIXELS / pixels);

  return Math.min(EXPORT_RASTER_SCALE, maxScale);
}

function drawExportBackground(context: CanvasRenderingContext2D, bounds: ExportBounds) {
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

function drawExportGroups(context: CanvasRenderingContext2D) {
  const styles = exportStyles();

  groups.forEach((group) => {
    const bounds = groupBounds(group);

    if (!bounds) {
      return;
    }

    const groupColorValue = groupColor(group);
    context.save();
    context.fillStyle = mixCssColors(groupColorValue, styles.groupSurfaceTint, styles.surface);
    context.strokeStyle = mixCssColors(groupColorValue, styles.groupStrokeTint, styles.outlineVariant);
    context.lineWidth = 1.5;
    context.setLineDash([8, 6]);
    roundedRect(context, bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 10);
    context.fill();
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = styles.textVariant;
    context.font = exportFont(13, 700);
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.fillText(group.name.trim() || "Untitled group", bounds.left + 16, bounds.top + 22, bounds.right - bounds.left - 32);
    context.restore();
  });
}

function drawExportEdges(context: CanvasRenderingContext2D) {
  const styles = exportStyles();

  visibleEdges().forEach((edge) => {
    const route = exportRouteForEdge(edge);

    if (!route) {
      return;
    }

    context.save();
    context.strokeStyle = styles.edge;
    context.lineWidth = 2.2;
    context.lineCap = "butt";
    context.lineJoin = "miter";
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

  visibleEdges().forEach((edge) => {
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

  visibleNodes().sort(compareNodesByPosition).forEach((node) => {
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

function wrapTextLinesForFont(text: string, maxWidth: number, font: string, maxLines: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0 || maxLines <= 0) {
    return [];
  }

  const lines: string[] = [];
  let currentLine = "";

  words.forEach((word) => {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (measureExportText(candidate, font) <= maxWidth || !currentLine) {
      currentLine = candidate;
      return;
    }

    lines.push(currentLine);
    currentLine = word;
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines
    .slice(0, maxLines)
    .map((line, index) => {
      const isLastVisibleLine = index === maxLines - 1 && lines.length > maxLines;
      return ellipsizeTextForFont(isLastVisibleLine ? `${line}...` : line, maxWidth, font);
    });
}

function ellipsizeTextForFont(text: string, maxWidth: number, font: string) {
  if (measureExportText(text, font) <= maxWidth) {
    return text;
  }

  let output = text.replace(/\.*$/, "");

  while (output.length > 0 && measureExportText(`${output}...`, font) > maxWidth) {
    output = output.slice(0, -1);
  }

  return `${output.trimEnd()}...`;
}

function measureExportText(text: string, font: string) {
  if (!edgeLabelMeasureContext) {
    edgeLabelMeasureContext = document.createElement("canvas").getContext("2d");
  }

  if (!edgeLabelMeasureContext) {
    return text.length * 7.2;
  }

  edgeLabelMeasureContext.font = font;
  return edgeLabelMeasureContext.measureText(text).width;
}

function exportRouteForEdge(edge: DependencyEdge): RoutedEdgeLayout | null {
  return routeForEdge(edge);
}

function routeForEdge(edge: DependencyEdge): RoutedEdgeLayout | null {
  const baseRoute = baseRouteForEdge(edge);

  if (!baseRoute) {
    return null;
  }

  const manualPoints = edge.manualRoute ? routePointsForEdge(edge, edge.manualRoute)
    : automaticRoutePreview(edge, baseRoute);

  if (!manualPoints) {
    const basePoints = pathPointsFromSvgPath(baseRoute.path);
    const manualLabelPoint =
      typeof edge.manualLabelPosition === "number"
        ? pointAtPolylinePosition(basePoints, edge.manualLabelPosition)
        : null;

    return manualLabelPoint
      ? {
          ...baseRoute,
          labelX: manualLabelPoint.x,
          labelY: manualLabelPoint.y,
        }
      : baseRoute;
  }

  const labelPoint =
    typeof edge.manualLabelPosition === "number"
      ? pointAtPolylinePosition(manualPoints, edge.manualLabelPosition)
      : pointAtPolylinePosition(manualPoints, edge.manualRoute ? 0.5
        : nearestPolylinePosition({ x: baseRoute.labelX, y: baseRoute.labelY }, pathPointsFromSvgPath(baseRoute.path)));

  return {
    path: orthogonalPath(manualPoints),
    arrowPoints: arrowForRoute(manualPoints),
    labelX: labelPoint.x,
    labelY: labelPoint.y,
  };
}

// While D2 is working, retain its chosen ports and bend directions. Reattaching
// by guessing a side from the next bend made ports flip during an otherwise
// unchanged drag, and moving every label to the midpoint added another jump.
function automaticRoutePreview(edge: DependencyEdge, route: RoutedEdgeLayout): Point[] | null {
  const oldFrom = automaticRoutes?.nodes.get(edge.from), oldTo = automaticRoutes?.nodes.get(edge.to);
  const from = getNode(edge.from), to = getNode(edge.to);
  if (!oldFrom || !oldTo || !from || !to) return null;
  const unchanged = (before: RoutedNodeLayout, after: PuzzleNode) =>
    before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height;
  if (unchanged(oldFrom, from) && unchanged(oldTo, to)) return null;
  const points = pathPointsFromSvgPath(route.path);
  if (points.length < 2) return null;
  const fromDelta = { x: from.x - oldFrom.x, y: from.y - oldFrom.y };
  const toDelta = { x: to.x - oldTo.x, y: to.y - oldTo.y };
  if (fromDelta.x === toDelta.x && fromDelta.y === toDelta.y &&
      from.width === oldFrom.width && from.height === oldFrom.height &&
      to.width === oldTo.width && to.height === oldTo.height) {
    return points.map(point => translatePoint(point, fromDelta));
  }
  const startHorizontal = Math.abs(points[0].y - points[1].y) < 0.1;
  const endHorizontal = Math.abs(points[points.length - 1].y - points[points.length - 2].y) < 0.1;
  if (points.length === 3 && startHorizontal === endHorizontal) {
    points.splice(2, 0, { ...points[1] });
  }
  const movePort = (point: Point, before: RoutedNodeLayout, after: PuzzleNode) => ({
    x: after.x + (point.x - before.x) * after.width / before.width,
    y: after.y + (point.y - before.y) * after.height / before.height,
  });
  points[0] = movePort(points[0], oldFrom, from);
  points[points.length - 1] = movePort(points[points.length - 1], oldTo, to);
  if (points.length === 2) {
    const [start, end] = points;
    if (!isOrthogonalSegment(start, end)) {
      if (startHorizontal) {
        const x = (start.x + end.x) / 2;
        points.splice(1, 0, { x, y: start.y }, { x, y: end.y });
      } else {
        const y = (start.y + end.y) / 2;
        points.splice(1, 0, { x: start.x, y }, { x: end.x, y });
      }
    }
  } else {
    if (startHorizontal) points[1].y = points[0].y;
    else points[1].x = points[0].x;
    if (endHorizontal) points[points.length - 2].y = points[points.length - 1].y;
    else points[points.length - 2].x = points[points.length - 1].x;
  }
  return compactRoutePoints(points);
}

function baseRouteForEdge(edge: DependencyEdge): RoutedEdgeLayout | null {
  const routed = automaticRoutes?.edges.get(edge.id);
  if (routed) return routed;
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

function routePointsForEdge(edge: DependencyEdge, points: Point[]) {
  const routePoints = compactRoutePoints(points);

  if (routePoints.length < 2) {
    return null;
  }

  const from = getNode(edge.from);
  const to = getNode(edge.to);

  if (!from || !to) {
    return routePoints;
  }

  const adjusted = routePoints.map((point) => ({ ...point }));
  adjusted[0] = anchorPointForNode(from, adjusted[1]);
  adjusted[adjusted.length - 1] = anchorPointForNode(to, adjusted[adjusted.length - 2]);

  return compactRoutePoints(orthogonalizeEndpointSegments(adjusted, from, to));
}

function anchorPointForNode(node: PuzzleNode, neighbor: Point): Point {
  const left = node.x;
  const right = node.x + node.width;
  const top = node.y;
  const bottom = node.y + node.height;
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const dx = neighbor.x - centerX;
  const dy = neighbor.y - centerY;
  const horizontalWeight = Math.abs(dx) / Math.max(node.width, 1);
  const verticalWeight = Math.abs(dy) / Math.max(node.height, 1);
  const inset = 16;

  if (horizontalWeight >= verticalWeight) {
    return {
      x: dx >= 0 ? right : left,
      y: clamp(neighbor.y, top + inset, bottom - inset),
    };
  }

  return {
    x: clamp(neighbor.x, left + inset, right - inset),
    y: dy >= 0 ? bottom : top,
  };
}

function arrowForRoute(points: Point[]) {
  const end = points[points.length - 1];

  if (!end) {
    return [];
  }

  for (let index = points.length - 2; index >= 0; index -= 1) {
    const start = points[index];

    if (start && distanceBetween(start, end) > 0.1) {
      return arrowForLine(start, end);
    }
  }

  return [];
}

function orthogonalizeEndpointSegments(points: Point[], from: PuzzleNode, to: PuzzleNode) {
  if (points.length < 2) {
    return points;
  }

  const result = points.map((point) => ({ ...point }));
  const first = result[0];
  const second = result[1];

  if (first && second && !isOrthogonalSegment(first, second)) {
    result.splice(1, 0, bendPointForNodeAnchor(first, second, from));
  }

  const last = result[result.length - 1];
  const penultimate = result[result.length - 2];

  if (last && penultimate && !isOrthogonalSegment(penultimate, last)) {
    result.splice(result.length - 1, 0, bendPointForNodeAnchor(last, penultimate, to));
  }

  return result;
}

function isOrthogonalSegment(start: Point, end: Point) {
  return Math.abs(start.x - end.x) < 0.1 || Math.abs(start.y - end.y) < 0.1;
}

function bendPointForNodeAnchor(anchor: Point, neighbor: Point, node: PuzzleNode): Point {
  const side = nodeAnchorSide(node, anchor);

  return side === "left" || side === "right"
    ? { x: neighbor.x, y: anchor.y }
    : { x: anchor.x, y: neighbor.y };
}

function nodeAnchorSide(node: PuzzleNode, anchor: Point) {
  const leftDistance = Math.abs(anchor.x - node.x);
  const rightDistance = Math.abs(anchor.x - (node.x + node.width));
  const topDistance = Math.abs(anchor.y - node.y);
  const bottomDistance = Math.abs(anchor.y - (node.y + node.height));
  const smallest = Math.min(leftDistance, rightDistance, topDistance, bottomDistance);

  if (smallest === leftDistance) {
    return "left";
  }

  if (smallest === rightDistance) {
    return "right";
  }

  if (smallest === topDistance) {
    return "top";
  }

  return "bottom";
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

function movedRoutePoints(state: EdgeRouteDragState, point: Point) {
  const points = state.originalPoints.map((routePoint) => ({ ...routePoint }));
  const start = points[state.segmentIndex];
  const end = points[state.segmentIndex + 1];

  if (!start || !end) {
    return points;
  }

  const deltaX = point.x - state.startPoint.x;
  const deltaY = point.y - state.startPoint.y;

  if (state.orientation === "horizontal") {
    const nextY = routeDragCoordinate((start.y + end.y) / 2 + deltaY, "y");
    points[state.segmentIndex] = { ...start, y: nextY };
    points[state.segmentIndex + 1] = { ...end, y: nextY };
  } else if (state.orientation === "vertical") {
    const nextX = routeDragCoordinate((start.x + end.x) / 2 + deltaX, "x");
    points[state.segmentIndex] = { ...start, x: nextX };
    points[state.segmentIndex + 1] = { ...end, x: nextX };
  } else {
    points[state.segmentIndex] = clampPointToWorld({ x: start.x + deltaX, y: start.y + deltaY });
    points[state.segmentIndex + 1] = clampPointToWorld({ x: end.x + deltaX, y: end.y + deltaY });
  }

  return cleanManualRoutePoints(points);
}

function cleanManualRoutePoints(points: Point[]) {
  return simplifyRoutePoints(manhattanizeRoutePoints(compactRoutePoints(points.map(clampPointToWorld))));
}

function manhattanizeRoutePoints(points: Point[]) {
  if (points.length < 2) {
    return points;
  }

  const result: Point[] = [{ ...points[0] }];

  for (const point of points.slice(1)) {
    const previous = result[result.length - 1];

    if (!previous) {
      result.push({ ...point });
      continue;
    }

    if (!isOrthogonalSegment(previous, point)) {
      const beforePrevious = result[result.length - 2];
      result.push(bendPointForSegment(previous, point, beforePrevious));
    }

    result.push({ ...point });
  }

  return result;
}

function bendPointForSegment(start: Point, end: Point, previous?: Point) {
  const previousOrientation = previous ? segmentOrientation(previous, start) : null;

  if (previousOrientation === "vertical") {
    return { x: start.x, y: end.y };
  }

  if (previousOrientation === "horizontal") {
    return { x: end.x, y: start.y };
  }

  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
    ? { x: end.x, y: start.y }
    : { x: start.x, y: end.y };
}

function simplifyRoutePoints(points: Point[]) {
  let simplified = compactRoutePoints(points);
  let changed = true;

  while (changed) {
    changed = false;

    for (let index = 1; index < simplified.length - 1; index += 1) {
      const previous = simplified[index - 1];
      const point = simplified[index];
      const next = simplified[index + 1];

      if (areCollinear(previous, point, next)) {
        simplified = [...simplified.slice(0, index), ...simplified.slice(index + 1)];
        changed = true;
        break;
      }
    }
  }

  return compactRoutePoints(simplified);
}

function areCollinear(a: Point, b: Point, c: Point) {
  return (
    (Math.abs(a.x - b.x) < 0.1 && Math.abs(b.x - c.x) < 0.1) ||
    (Math.abs(a.y - b.y) < 0.1 && Math.abs(b.y - c.y) < 0.1)
  );
}

function routeDragCoordinate(value: number, axis: "x" | "y") {
  const max = axis === "x" ? world.width : world.height;

  if (snapToGrid) {
    return snapCoordinateWithin(value, 0, max);
  }

  return clamp(value, 0, max);
}

function segmentOrientation(start: Point, end: Point): EdgeSegmentOrientation {
  const deltaX = Math.abs(end.x - start.x);
  const deltaY = Math.abs(end.y - start.y);

  if (deltaX < 1 && deltaY < 1) {
    return "free";
  }

  return deltaX >= deltaY ? "horizontal" : "vertical";
}

function nearestRouteSegmentIndex(point: Point, points: Point[]) {
  if (points.length < 2) {
    return null;
  }

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < points.length - 1; index += 1) {
    const distance = distanceToSegment(point, points[index], points[index + 1]);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function nearestPolylinePosition(point: Point, points: Point[]) {
  const totalLength = polylineLength(points);

  if (totalLength === 0) {
    return 0.5;
  }

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestDistanceAlongPath = 0;
  let travelled = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const segmentLength = distanceBetween(start, end);

    if (segmentLength === 0) {
      continue;
    }

    const projection = projectedPointOnSegment(point, start, end);
    const distance = distanceBetween(point, projection.point);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestDistanceAlongPath = travelled + segmentLength * projection.t;
    }

    travelled += segmentLength;
  }

  return clamp(bestDistanceAlongPath / totalLength, 0, 1);
}

function pointAtPolylinePosition(points: Point[], position: number): Point {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }

  if (points.length === 1) {
    return points[0];
  }

  const totalLength = polylineLength(points);

  if (totalLength === 0) {
    return midpoint(points);
  }

  const targetDistance = clamp(position, 0, 1) * totalLength;
  let travelled = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const segmentLength = distanceBetween(start, end);

    if (segmentLength === 0) {
      continue;
    }

    if (travelled + segmentLength >= targetDistance) {
      const t = (targetDistance - travelled) / segmentLength;

      return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      };
    }

    travelled += segmentLength;
  }

  return points[points.length - 1];
}

function polylineLength(points: Point[]) {
  let length = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    length += distanceBetween(points[index], points[index + 1]);
  }

  return length;
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  return distanceBetween(point, projectedPointOnSegment(point, start, end).point);
}

function projectedPointOnSegment(point: Point, start: Point, end: Point) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;

  if (lengthSquared === 0) {
    return { point: start, t: 0 };
  }

  const t = clamp(((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared, 0, 1);

  return {
    point: {
      x: start.x + deltaX * t,
      y: start.y + deltaY * t,
    },
    t,
  };
}

function clampPointToWorld(point: Point): Point {
  return {
    x: clamp(point.x, 0, world.width),
    y: clamp(point.y, 0, world.height),
  };
}

function compactRoutePoints(points: Point[]) {
  const compacted: Point[] = [];

  for (const point of points) {
    const previous = compacted[compacted.length - 1];

    if (!previous || distanceBetween(previous, point) > 0.1) {
      compacted.push(point);
    }
  }

  return compacted;
}

function renderGraphToSvgBlob() {
  refreshAutomaticRoutesIfNeeded();

  return new Blob([renderGraphToSvg(measureExportBounds())], {
    type: "image/svg+xml;charset=utf-8",
  });
}

function renderGraphToSvg(bounds: ExportBounds) {
  const styles = exportStyles();
  const isDark = document.documentElement.dataset.theme === "dark";
  const shadowOpacity = isDark ? 0.36 : 0.18;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="${bounds.left} ${bounds.top} ${bounds.width} ${bounds.height}">
  <defs>
    <filter id="node-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="${shadowOpacity}" />
    </filter>
  </defs>
  <rect x="${bounds.left}" y="${bounds.top}" width="${bounds.width}" height="${bounds.height}" fill="${escapeAttribute(styles.surface)}" />
  ${svgGrid(bounds, styles)}
  ${svgGroups(styles)}
  ${svgEdges(styles)}
  ${svgNodes(styles)}
</svg>
`;
}

function svgGrid(bounds: ExportBounds, styles: ReturnType<typeof exportStyles>) {
  const lines: string[] = [];
  const startX = Math.floor(bounds.left / 24) * 24;
  const startY = Math.floor(bounds.top / 24) * 24;

  for (let x = startX; x <= bounds.right; x += 24) {
    lines.push(`<line x1="${x}" y1="${bounds.top}" x2="${x}" y2="${bounds.bottom}" />`);
  }

  for (let y = startY; y <= bounds.bottom; y += 24) {
    lines.push(`<line x1="${bounds.left}" y1="${y}" x2="${bounds.right}" y2="${y}" />`);
  }

  return `<g stroke="${escapeAttribute(styles.grid)}" stroke-width="1" shape-rendering="crispEdges">${lines.join("")}</g>`;
}

function svgGroups(styles: ReturnType<typeof exportStyles>) {
  return groups
    .map((group) => {
      const bounds = groupBounds(group);

      if (!bounds) {
        return "";
      }

      const width = bounds.right - bounds.left;
      const height = bounds.bottom - bounds.top;
      const groupColorValue = groupColor(group);
      const surface = mixCssColors(groupColorValue, styles.groupSurfaceTint, styles.surface);
      const stroke = mixCssColors(groupColorValue, styles.groupStrokeTint, styles.outlineVariant);

      return `<g>
        <rect x="${bounds.left}" y="${bounds.top}" width="${width}" height="${height}" rx="10" fill="${escapeAttribute(surface)}" stroke="${escapeAttribute(stroke)}" stroke-width="1.5" stroke-dasharray="8 6" />
        <text x="${bounds.left + 16}" y="${bounds.top + 22}" fill="${escapeAttribute(styles.textVariant)}" font-family="${escapeAttribute(EXPORT_FONT_FAMILY)}" font-size="13" font-weight="700" dominant-baseline="middle">${escapeHtml(group.name.trim() || "Untitled group")}</text>
      </g>`;
    })
    .join("");
}

function svgEdges(styles: ReturnType<typeof exportStyles>) {
  const edgeLines = visibleEdges()
    .map((edge) => {
      const route = exportRouteForEdge(edge);

      if (!route) {
        return "";
      }

      const arrow = route.arrowPoints.length
        ? `<polygon points="${route.arrowPoints.map((point) => `${round(point.x)},${round(point.y)}`).join(" ")}" fill="${escapeAttribute(styles.edge)}" />`
        : "";

      return `<g>
        <path d="${escapeAttribute(route.path)}" fill="none" stroke="${escapeAttribute(styles.edge)}" stroke-width="2.2" stroke-linecap="butt" stroke-linejoin="miter" />
        ${arrow}
      </g>`;
    })
    .join("");
  const edgeLabels = visibleEdges()
    .map((edge) => {
      const route = exportRouteForEdge(edge);
      const label = edge.label.trim();

      if (!route || !label) {
        return "";
      }

      const metrics = measureEdgeLabel(label);
      const text = ellipsizeTextForFont(label, metrics.width - 16, exportFont(12, 500));

      return `<g>
        <rect x="${round(route.labelX - metrics.width / 2)}" y="${round(route.labelY - metrics.height / 2)}" width="${metrics.width}" height="${metrics.height}" rx="6" fill="${escapeAttribute(styles.edgeLabelSurface)}" stroke="${escapeAttribute(styles.outlineVariant)}" />
        <text x="${round(route.labelX)}" y="${round(route.labelY + 1)}" fill="${escapeAttribute(styles.textVariant)}" font-family="${escapeAttribute(EXPORT_FONT_FAMILY)}" font-size="12" font-weight="500" text-anchor="middle" dominant-baseline="middle">${escapeHtml(text)}</text>
      </g>`;
    })
    .join("");

  return `<g>${edgeLines}${edgeLabels}</g>`;
}

function svgNodes(styles: ReturnType<typeof exportStyles>) {
  const analysis = analyzeGraph();
  const roots = new Set(analysis.roots.map((node) => node.id));
  const leaves = new Set(analysis.leaves.map((node) => node.id));

  return visibleNodes()
    .sort(compareNodesByPosition)
    .map((node, index) => {
      const nodeColorValue = nodeColor(node);
      const nodeSurface = mixCssColors(nodeColorValue, styles.nodeSurfaceTint, styles.surfaceLowest);
      const borderColor = mixCssColors(nodeColorValue, 0.24, styles.outlineVariant);
      const role = roots.has(node.id) ? "Root" : leaves.has(node.id) ? "Leaf" : "Linked";
      const incoming = incomingEdges(node.id).length;
      const outgoing = outgoingEdges(node.id).length;
      const clipId = `node-clip-${index}`;

      return `<g>
        <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="${escapeAttribute(nodeSurface)}" stroke="${escapeAttribute(borderColor)}" filter="url(#node-shadow)" />
        <clipPath id="${clipId}"><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" /></clipPath>
        <g clip-path="url(#${clipId})">
          ${svgNodeTopline(node, role, nodeColorValue, styles)}
          ${svgNodeBody(node, styles)}
          ${svgNodeFooter(node, incoming, outgoing, styles)}
        </g>
      </g>`;
    })
    .join("");
}

function svgNodeTopline(
  node: PuzzleNode,
  role: string,
  nodeColorValue: string,
  styles: ReturnType<typeof exportStyles>,
) {
  const x = node.x + 12;
  const y = node.y + 13;

  return `<g>
    <circle cx="${x + 9}" cy="${y + 9}" r="8" fill="${escapeAttribute(nodeColorValue)}" stroke="${escapeAttribute(styles.swatchBorder)}" stroke-width="2" />
    <text x="${x + 27}" y="${y + 9}" fill="${escapeAttribute(styles.textVariant)}" font-family="${escapeAttribute(EXPORT_FONT_FAMILY)}" font-size="11" font-weight="500" dominant-baseline="middle">${escapeHtml(labelForKind(node.kind))}</text>
    <text x="${node.x + node.width - 12}" y="${y + 9}" fill="${escapeAttribute(styles.textVariant)}" font-family="${escapeAttribute(EXPORT_FONT_FAMILY)}" font-size="11" font-weight="500" text-anchor="end" dominant-baseline="middle">${escapeHtml(role)}</text>
  </g>`;
}

function svgNodeBody(node: PuzzleNode, styles: ReturnType<typeof exportStyles>) {
  const contentX = node.x + 12;
  const contentWidth = node.width - 24;
  const titleFont = exportFont(14, 700);
  const noteFont = exportFont(11, 400);
  const titleLines = wrapTextLinesForFont(node.title, contentWidth, titleFont, 2);
  const noteY = node.y + 42 + titleLines.length * 17;
  const footerTop = node.y + node.height - 35;
  const availableNoteLines = Math.max(0, Math.floor((footerTop - noteY - 4) / 14));
  const noteLines = availableNoteLines > 0
    ? wrapTextLinesForFont(node.note, contentWidth, noteFont, availableNoteLines)
    : [];

  return `<g>
    ${svgTextBlock(titleLines, contentX, node.y + 53, 17, styles.text, 14, 700, "start")}
    ${svgTextBlock(noteLines, contentX, noteY + 11, 14, styles.textVariant, 11, 400, "start")}
  </g>`;
}

function svgNodeFooter(
  node: PuzzleNode,
  incoming: number,
  outgoing: number,
  styles: ReturnType<typeof exportStyles>,
) {
  const y = node.y + node.height - 28;
  const difficulty = typeof node.difficulty === "number"
    ? `<text x="${node.x + node.width - 12}" y="${y}" text-anchor="end">${escapeHtml(`Difficulty ${node.difficulty}`)}</text>`
    : "";

  return `<g fill="${escapeAttribute(styles.textVariant)}" font-family="${escapeAttribute(EXPORT_FONT_FAMILY)}" font-size="11" font-weight="500" dominant-baseline="middle">
    <line x1="${node.x + 12}" y1="${node.y + node.height - 35}" x2="${node.x + node.width - 12}" y2="${node.y + node.height - 35}" stroke="${escapeAttribute(styles.outlineVariant)}" stroke-width="1" />
    <text x="${node.x + 12}" y="${y}">${incoming} in</text>
    <text x="${node.x + node.width / 2}" y="${y}" text-anchor="middle">${outgoing} out</text>
    ${difficulty}
  </g>`;
}

function svgTextBlock(
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
  fill: string,
  fontSize: number,
  fontWeight: number,
  textAnchor: "start" | "middle" | "end",
) {
  if (lines.length === 0) {
    return "";
  }

  const tspans = lines
    .map((line, index) => `<tspan x="${x}" y="${y + index * lineHeight}">${escapeHtml(line)}</tspan>`)
    .join("");

  return `<text fill="${escapeAttribute(fill)}" font-family="${escapeAttribute(EXPORT_FONT_FAMILY)}" font-size="${fontSize}" font-weight="${fontWeight}" text-anchor="${textAnchor}">${tspans}</text>`;
}

function exportStyles() {
  return {
    edge: cssVar("--edge-color"),
    edgeLabelSurface: cssVar("--edge-label-surface"),
    groupStrokeTint: 0.52,
    groupSurfaceTint: document.documentElement.dataset.theme === "dark" ? 0.18 : 0.1,
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
  return `${weight} ${size}px ${EXPORT_FONT_FAMILY}`;
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

async function canvasToPdfBlob(raster: RasterExport) {
  const jpegBlob = await canvasToBlob(raster.canvas, "image/jpeg", 0.98);
  return singleImagePdfBlob(
    new Uint8Array(await jpegBlob.arrayBuffer()),
    raster.canvas.width,
    raster.canvas.height,
    raster.bounds.width,
    raster.bounds.height,
  );
}

function singleImagePdfBlob(
  jpegBytes: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  logicalWidth: number,
  logicalHeight: number,
) {
  const pageWidth = round(logicalWidth * 0.75);
  const pageHeight = round(logicalHeight * 0.75);
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

function blobForExportFormat(format: ExportFormat) {
  if (format === "svg") {
    return renderGraphToSvgBlob();
  }

  const raster = renderGraphToCanvas();

  if (format === "png") {
    return canvasToBlob(raster.canvas, "image/png");
  }

  if (format === "jpg") {
    return canvasToBlob(raster.canvas, "image/jpeg", 0.96);
  }

  return canvasToPdfBlob(raster);
}

function isTauriRuntime() {
  return isTauri();
}

function extensionForExportFormat(format: ExportFormat) {
  return format;
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

  if (format === "svg") {
    return { name: "SVG Vector Image", extensions: ["svg"] };
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
  return value === "png" || value === "jpg" || value === "pdf" || value === "svg";
}

async function confirmAutoLayout() {
  if (isTauriRuntime()) {
    return ask(AUTO_LAYOUT_CONFIRM_MESSAGE, {
      title: "Auto Layout",
      kind: "warning",
      okLabel: "Auto Layout",
      cancelLabel: "Cancel",
    });
  }

  return window.confirm(AUTO_LAYOUT_CONFIRM_MESSAGE);
}

async function autoArrange() {
  if (layoutActionRunning || !currentGraph) return;
  const session = documentSession;
  layoutActionRunning = true;
  try {
    if (!(await confirmAutoLayout()) || session !== documentSession) return;
    if (!(await initializeLayoutEngine()) || session !== documentSession) { render(); return; }
    const revision = routingRevision;
    try {
      const layout = await computeRoutedLayout("auto");
      if (session !== documentSession || revision !== routingRevision) return;
      withGraphEdit(() => {
        nodes = nodes.map(node => {
          const position = layout.nodes.get(node.id);
          return position ? { ...node, x: position.x, y: position.y } : node;
        });
        acceptRoutedLayout(layout);
        routingError = null;
        canvasScroll.scrollLeft = 0;
        canvasScroll.scrollTop = 0;
        render();
      });
    } catch (error) {
      if (session !== documentSession) return;
      routingError = error instanceof Error ? error.message : "Unable to arrange this graph.";
      render();
    }
  } finally { layoutActionRunning = false; }
}

async function rerouteConnections() {
  if (layoutActionRunning || !currentGraph || !visibleEdges().length) return;
  const session = documentSession;
  layoutActionRunning = true;
  try {
    const confirmed = isTauriRuntime()
      ? await ask(REROUTE_CONFIRM_MESSAGE, { title: "Reroute connections", kind: "warning", okLabel: "Reroute", cancelLabel: "Cancel" })
      : window.confirm(REROUTE_CONFIRM_MESSAGE);
    if (!confirmed || session !== documentSession) return;
    if (!(await initializeLayoutEngine()) || session !== documentSession) { render(); return; }
    const revision = routingRevision;
    try {
      const layout = await computeRoutedLayout("fixed");
      if (session !== documentSession || revision !== routingRevision) return;
      withGraphEdit(() => {
        acceptRoutedLayout(layout);
        routingError = null;
        render();
      });
    } catch (error) {
      if (session !== documentSession) return;
      routingError = error instanceof Error ? error.message : "Unable to reroute connections.";
      render();
    }
  } finally { layoutActionRunning = false; }
}

// Accepted geometry is document data, never a disposable render cache. This
// makes reopen, export, undo and view changes reproduce the same waypoints.
function acceptRoutedLayout(layout: RoutedLayout) {
  routingRevision += 1;
  routingContentRevision += 1;
  edges = edges.map(edge => {
    const route = layout.edges.get(edge.id);
    if (!route) return edge;
    const points = compactRoutePoints(pathPointsFromSvgPath(route.path));
    if (points.length < 2) return edge;
    return { ...edge, manualRoute: points,
      manualLabelPosition: nearestPolylinePosition({ x: route.labelX, y: route.labelY }, points) };
  });
  automaticRoutes = layout;
  automaticRoutesDirty = false;
  resizeWorld(Math.max(world.width, layout.width), Math.max(world.height, layout.height));
}

function deleteSelection() {
  if (selectedGroupId) {
    void deleteGroupWithConfirmation(selectedGroupId);
    return;
  }

  if (selectedNodeIds.size > 0) {
    withGraphEdit(() => {
      const nodeIds = new Set(selectedNodeIds);

      if (nodeIds.size === 0) {
        return;
      }

      deleteNodesById(nodeIds);
      clearSelection();
      render();
    });
    return;
  }

  if (selectedEdgeId) {
    withGraphEdit(() => {
      const edgeId = selectedEdgeId;

      if (!edgeId) {
        return;
      }

      edges = edges.filter((edge) => edge.id !== edgeId);
      invalidateAutomaticRoutes();
      clearSelection();
        render();
    });
  }
}

function createGroupFromSelection() {
  const nodeIds = [...selectedNodeIds].filter((nodeId) => getNode(nodeId));

  if (nodeIds.length < 2) {
    return;
  }

  withGraphEdit(() => {
    const selectedIds = new Set(nodeIds);
    const group: PuzzleGroup = {
      id: `g-custom-${groupSerial}`,
      name: `Group ${groupSerial}`,
      color: defaultGroupColor(groupSerial),
      nodeIds,
      hidden: false,
    };

    groupSerial += 1;
    groups = [
      ...groups
        .map((candidate) => ({
          ...candidate,
          nodeIds: candidate.nodeIds.filter((nodeId) => !selectedIds.has(nodeId)),
        }))
        .filter((candidate) => candidate.nodeIds.length > 0),
      group,
    ];
    selectOnlyGroup(group.id);
    render();
  });
}

function toggleGroupHidden(groupId: string) {
  const group = getGroup(groupId);

  if (!group) {
    return;
  }

  withGraphEdit(() => {
    updateGroup(groupId, { hidden: !group.hidden });
    selectOnlyGroup(groupId);
    render();
  });
}

function ungroup(groupId: string) {
  const group = getGroup(groupId);

  if (!group) {
    return;
  }

  withGraphEdit(() => {
    groups = groups.filter((candidate) => candidate.id !== groupId);
    setSelectedNodes(group.nodeIds, group.nodeIds[0]);
    render();
  });
}

async function deleteGroupWithConfirmation(groupId: string) {
  const group = getGroup(groupId);

  if (!group) {
    return;
  }

  const memberCount = group.nodeIds.filter((nodeId) => getNode(nodeId)).length;
  const message = `Delete "${group.name || "Untitled group"}" and its ${memberCount} nodes? This also removes connected dependencies.`;
  const confirmed = isTauriRuntime()
    ? await ask(message, {
        title: "Delete Group",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      })
    : window.confirm(message);

  if (!confirmed) {
    return;
  }

  withGraphEdit(() => {
    deleteNodesById(new Set(group.nodeIds));
    groups = groups.filter((candidate) => candidate.id !== groupId);
    clearSelection();
    render();
  });
}

function deleteNodesById(nodeIds: Set<string>) {
  invalidateAutomaticRoutes();
  nodes = nodes.filter((node) => !nodeIds.has(node.id));
  edges = edges.filter((edge) => !nodeIds.has(edge.from) && !nodeIds.has(edge.to));
  groups = groups
    .map((group) => ({
      ...group,
      nodeIds: group.nodeIds.filter((nodeId) => !nodeIds.has(nodeId)),
    }))
    .filter((group) => group.nodeIds.length > 0);

  if (selectedGroupId && !groups.some((group) => group.id === selectedGroupId)) {
    selectedGroupId = null;
  }

}

function render() {
  if (simulationActive) completedNodeIds = dependencyModel().validCompleted(completedNodeIds);
  renderAppMode();

  if (!currentGraph) {
    renderWelcome();
    ensureButtonTooltips();
    hydrateIcons();
    return;
  }

  refreshAutomaticRoutesIfNeeded();
  const analysis = analyzeGraph();

  renderCenterTabs();
  renderToolbar();
  renderGroups();
  renderEdges();
  renderNodes(analysis);
  renderSelectionBox();
  renderMetrics(analysis);
  renderWidthBars(analysis);
  renderWarnings(analysis);
  if (activeCenterTab === "pacing") renderPacingView(analysis);
  renderInspector();
  renderExplorer();
  renderSimulation();
  updateSaveStatus();
  ensureButtonTooltips();
  hydrateIcons();
}

function renderAppMode() {
  const isWelcome = !currentGraph;
  appShell.classList.toggle("is-welcome", isWelcome);
  welcomeScreen.hidden = !isWelcome;
  workbench.hidden = isWelcome;
}

function renderCenterTabs() {
  const chartButton = must<HTMLButtonElement>("#view-chart");
  const pacingButton = must<HTMLButtonElement>("#view-pacing");
  const isChart = activeCenterTab === "chart";

  chartPanel.hidden = !isChart;
  pacingPanel.hidden = isChart;

  chartButton.classList.toggle("active", isChart);
  pacingButton.classList.toggle("active", !isChart);
  chartButton.setAttribute("aria-selected", String(isChart));
  pacingButton.setAttribute("aria-selected", String(!isChart));
  chartButton.tabIndex = isChart ? 0 : -1;
  pacingButton.tabIndex = isChart ? -1 : 0;
}

function renderWelcome() {
  must<HTMLButtonElement>("#recover-draft").hidden = !readRecovery();
  clearRecentButton.hidden = recentGraphs.length === 0;

  if (recentGraphs.length === 0) {
    recentList.innerHTML = `
      <p class="recent-empty">No recent graphs yet. Start a new graph or load a graph file.</p>
    `;
    return;
  }

  recentList.innerHTML = recentGraphs
    .map(
      (recent) => `
        <div class="recent-item" data-recent-id="${escapeAttribute(recent.id)}">
          <button class="recent-open" type="button" data-recent-open="${escapeAttribute(recent.id)}" title="Open ${escapeAttribute(recent.title)}">
            <strong>${escapeHtml(recent.title)}</strong>
            <span>${escapeHtml(recent.sourceName)}</span>
          </button>
          <button class="recent-delete" type="button" data-recent-delete="${escapeAttribute(recent.id)}" title="Remove from recent files" aria-label="Remove ${escapeAttribute(recent.title)} from recent files">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      `,
    )
    .join("");

  recentList.querySelectorAll<HTMLButtonElement>(".recent-open").forEach((button) => {
    button.addEventListener("click", async () => {
      const recent = recentGraphs.find((candidate) => candidate.id === button.dataset.recentOpen);

      if (!recent) {
        return;
      }

      if (!(await confirmLeaveGraph())) return;
      if (isTauriRuntime() && recent.filePath) {
        try {
          const document = normalizeGraphDocument(JSON.parse(await readTextFile(recent.filePath)));
          clearRecovery();
          openGraphDocument(document, recent.sourceName, true, recent.filePath);
        } catch {
          window.alert("This file could not be opened. Locate it again, or recover an unsaved draft if one is available.");
          await openGraphFile(recent.filePath);
        }
      } else {
        clearRecovery();
        openGraphDocument(recent.document, recent.sourceName, true);
      }
    });
  });

  recentList.querySelectorAll<HTMLButtonElement>(".recent-delete").forEach((button) => {
    button.addEventListener("click", () => {
      const recentId = button.dataset.recentDelete;

      if (!recentId) {
        return;
      }

      forgetRecentGraph(recentId);
    });
  });
}

function renderToolbar() {
  for (const tool of ["select", "node", "connect"] as Tool[]) {
    const button = must<HTMLButtonElement>(`#tool-${tool}`);
    button.classList.toggle("active", activeTool === tool);
  }

  updateHistoryControls();
  must<HTMLButtonElement>("#reroute-graph").disabled = visibleEdges().length === 0;
  updateSnapGridControl();
  layoutActionLabel.textContent = "Auto Layout";
  autoLayoutButton.title = "Rearrange nodes by dependency layers";
}

function renderNodes(analysis: GraphAnalysis = analyzeGraph()) {
  const roots = new Set(analysis.roots.map((node) => node.id));
  const leaves = new Set(analysis.leaves.map((node) => node.id));
  const available = simulationAvailableNodes();

  nodeLayer.innerHTML = visibleNodes()
    .map((node) => {
      const incoming = incomingEdges(node.id).length;
      const outgoing = outgoingEdges(node.id).length;
      const selected = (selectedNodeIds.has(node.id) ? " selected" : "") +
        simulationNodeClass(node.id, available);
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
          ${completionCross(node.id)}
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
            ${available && (available.has(node.id) || completedNodeIds.has(node.id))
              ? `<button class="node-solve-action" type="button" data-toggle-solved="${escapeAttribute(node.id)}" aria-pressed="${completedNodeIds.has(node.id)}" aria-label="${escapeAttribute(`${completedNodeIds.has(node.id) ? "Undo completion of" : "Mark solved:"} ${node.title}`)}">${completedNodeIds.has(node.id) ? "Undo" : "Solve"}</button>` : ""}
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

  nodeLayer.querySelectorAll<HTMLButtonElement>("[data-toggle-solved]").forEach(button => {
    button.addEventListener("pointerdown", event => event.stopPropagation());
    button.addEventListener("click", event => {
      event.stopPropagation();
      const id = button.dataset.toggleSolved!;
      toggleCompleted(id);
      // The Solve button becomes Undo; keep keyboard focus on that control.
      [...nodeLayer.querySelectorAll<HTMLButtonElement>("[data-toggle-solved]")]
        .find(candidate => candidate.dataset.toggleSolved === id)?.focus({ preventScroll: true });
    });
  });

  renderNodeGhost();
  applyDiagnosticHighlights(nodeLayer);
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

function renderSelectionBox() {
  const existingBox = graphSpace.querySelector<HTMLElement>(".selection-box");

  if (!selectionBoxState?.hasMoved) {
    existingBox?.remove();
    return;
  }

  const rect = rectFromPoints(selectionBoxState.start, selectionBoxState.current);
  const box =
    existingBox ??
    (() => {
      const element = document.createElement("div");
      element.className = "selection-box";
      graphSpace.appendChild(element);
      return element;
    })();

  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.right - rect.left}px`;
  box.style.height = `${rect.bottom - rect.top}px`;
}

function renderGroups() {
  const available = simulationAvailableNodes();
  groupLayer.innerHTML = groups
    .map((group) => {
      const bounds = groupBounds(group);

      if (!bounds) {
        return "";
      }

      const selected = group.id === selectedGroupId ? " selected" : "";
      const blocked = available && group.nodeIds.length && group.nodeIds.every(id =>
        !completedNodeIds.has(id) && !available.has(id)) ? " simulation-blocked" : "";
      const hidden = group.hidden ? " hidden" : "";
      const icon = group.hidden ? "eye-off" : "eye";
      const title = group.hidden ? "Show group" : "Hide group";
      const name = group.name.trim() || "Untitled group";
      const color = groupColor(group);

      return `
        <section
          class="group-box${selected}${hidden}${blocked}"
          data-group-id="${escapeAttribute(group.id)}"
          style="left: ${bounds.left}px; top: ${bounds.top}px; width: ${bounds.right - bounds.left}px; height: ${bounds.bottom - bounds.top}px; --group-color: ${escapeAttribute(color)};"
        >
          <div class="group-header">
            <span class="group-name" title="${escapeAttribute(name)}">${escapeHtml(name)}</span>
            <button class="group-visibility" type="button" data-group-toggle="${escapeAttribute(group.id)}" title="${title}" aria-label="${title}">
              <i data-lucide="${icon}"></i>
            </button>
          </div>
        </section>
      `;
    })
    .join("");

  groupLayer.querySelectorAll<HTMLElement>(".group-box").forEach((element) => {
    element.addEventListener("pointerdown", (event) => {
      const groupId = element.dataset.groupId;

      if (!groupId) {
        return;
      }

      event.stopPropagation();
      handleGroupPointerDown(event, groupId);
    });
  });

  groupLayer.querySelectorAll<HTMLButtonElement>(".group-visibility").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const groupId = button.dataset.groupToggle;

      if (groupId) {
        toggleGroupHidden(groupId);
      }
    });
  });
  applyDiagnosticHighlights(groupLayer);
}

function renderEdges(onlyIds?: Set<string>) {
  refreshAutomaticRoutesIfNeeded();
  const available = simulationAvailableNodes();
  const edgeMarkup = visibleEdges().filter(edge => !onlyIds || onlyIds.has(edge.id))
    .map((edge) => {
      const route = routeForEdge(edge);

      if (!route) {
        return "";
      }

      const selected = edge.id === selectedEdgeId ||
        (selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to)) ? " selected" : "";
      const flowing = available && completedNodeIds.has(edge.from) && available.has(edge.to);
      const simulation = !available ? "" : flowing ? " simulation-flowing"
        : completedNodeIds.has(edge.from) && completedNodeIds.has(edge.to) ? " simulation-traversed" : " simulation-blocked";
      const rawLabel = edge.label.trim();
      const label = escapeHtml(rawLabel);
      const labelMetrics = measureEdgeLabel(rawLabel);
      const labelMarkup = rawLabel
        ? `
          <rect class="edge-label-bg edge-pick edge-label-pick" data-edge-id="${escapeHtml(edge.id)}" x="${route.labelX - labelMetrics.width / 2}" y="${route.labelY - labelMetrics.height / 2}" width="${labelMetrics.width}" height="${labelMetrics.height}" rx="6"></rect>
          <text class="edge-label edge-pick edge-label-pick" data-edge-id="${escapeHtml(edge.id)}" x="${route.labelX}" y="${route.labelY + 4}">${label}</text>
        `
        : "";
      const arrowPoints = route.arrowPoints
        .map((point) => `${round(point.x)},${round(point.y)}`)
        .join(" ");
      const arrow = arrowPoints ? `<polygon class="edge-arrow" points="${arrowPoints}"></polygon>` : "";

      return `
        <g class="edge-group${selected}${simulation}" data-edge-id="${escapeHtml(edge.id)}">
          <path class="edge-path" d="${route.path}"></path>
          ${flowing ? `<path class="edge-flow" d="${route.path}" aria-hidden="true"></path>` : ""}
          ${arrow}
          <path class="edge-hit edge-pick" d="${route.path}" data-edge-id="${escapeHtml(edge.id)}"></path>
          ${labelMarkup}
        </g>
      `;
    })
    .join("");

  if (!onlyIds) edgeLayer.innerHTML = edgeMarkup;
  else {
    const staging = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    staging.innerHTML = edgeMarkup;
    const replacements = new Map([...staging.children].map(element => [(element as SVGElement).dataset.edgeId, element]));
    edgeLayer.querySelectorAll<SVGElement>(".edge-group").forEach(element => {
      if (!onlyIds.has(element.dataset.edgeId ?? "")) return;
      const replacement = replacements.get(element.dataset.edgeId);
      if (replacement) element.replaceWith(replacement); else element.remove();
    });
  }
  applyDiagnosticHighlights(edgeLayer);
}

// Checks and search navigate without changing which graph elements are shown.
// Only the explicit Focus actions isolate a subgraph.
function inspectNodes(ids: Iterable<string>, primaryId?: string) {
  const known = [...new Set(ids)].filter(id => !!getNode(id));
  if (!known.length) return;
  const wasFocused = focusNodeIds !== null;
  focusNodeIds = null;
  setSelectedNodes(known, primaryId);
  activeCenterTab = "chart";
  if (wasFocused) {
    render();
  } else {
    renderCenterTabs();
    renderGroups();
    renderNodes();
    renderEdges();
    renderInspector();
    renderExplorer();
    ensureButtonTooltips();
    hydrateIcons();
  }
  revealNodesAtCurrentZoom(known);
}

function revealNodesAtCurrentZoom(ids: string[]) {
  const candidates = ids.map(id => getNode(id)).filter((node): node is PuzzleNode => !!node && !isNodeHidden(node.id));
  if (!candidates.length) return;
  const margin = 32 / zoom;
  const width = canvasScroll.clientWidth / zoom;
  const height = canvasScroll.clientHeight / zoom;
  if (width <= 0 || height <= 0) return;
  let left = minOf(candidates.map(node => node.x), 0) - margin;
  let top = minOf(candidates.map(node => node.y), 0) - margin;
  let right = maxOf(candidates.map(node => node.x + node.width), 0) + margin;
  let bottom = maxOf(candidates.map(node => node.y + node.height), 0) + margin;
  // Widely separated warnings may not fit. Reveal the first target rather than
  // zooming out and making the whole chart unexpectedly tiny.
  if (right - left > width || bottom - top > height) {
    const first = candidates[0];
    left = first.x - margin; top = first.y - margin;
    right = first.x + first.width + margin; bottom = first.y + first.height + margin;
  }
  const scrollX = canvasScroll.scrollLeft / zoom;
  const scrollY = canvasScroll.scrollTop / zoom;
  if (left < scrollX) canvasScroll.scrollLeft = Math.max(0, left * zoom);
  else if (right > scrollX + width) canvasScroll.scrollLeft = Math.max(0, (right - width) * zoom);
  if (top < scrollY) canvasScroll.scrollTop = Math.max(0, top * zoom);
  else if (bottom > scrollY + height) canvasScroll.scrollTop = Math.max(0, (bottom - height) * zoom);
}

function clearFocus() {
  focusNodeIds = null;
  render();
  fitGraphToView();
}

function focusOnNodes(ids: Iterable<string>, selectedId?: string) {
  const known = [...ids].filter(id => !!getNode(id));
  focusNodeIds = new Set(known);
  // A requested focus should remain visible even inside a hidden group.
  if (selectedId) selectOnlyNode(selectedId); else setSelectedNodes(known);
  activeCenterTab = "chart";
  render();
  fitNodesToView(known);
}

function fitNodesToView(ids: string[]) {
  const focus = ids.map(id => getNode(id)).filter((node): node is PuzzleNode => !!node);
  if (!focus.length) return;
  const left = minOf(focus.map(node => node.x), 0);
  const top = minOf(focus.map(node => node.y), 0);
  const right = maxOf(focus.map(node => node.x + node.width), world.width);
  const bottom = maxOf(focus.map(node => node.y + node.height), world.height);
  zoom = clamp(Math.min((canvasScroll.clientWidth - 80) / Math.max(1, right-left), (canvasScroll.clientHeight - 80) / Math.max(1, bottom-top), 1.5), MIN_ZOOM, MAX_ZOOM);
  applyZoom();
  canvasScroll.scrollLeft = Math.max(0, left * zoom - 40);
  canvasScroll.scrollTop = Math.max(0, top * zoom - 40);
}

function renderExplorer() {
  const query = must<HTMLInputElement>("#node-search").value.trim().toLowerCase();
  const matching = query ? nodes.filter(node => `${node.title} ${node.note} ${node.id}`.toLowerCase().includes(query)) : [];
  must<HTMLElement>("#search-results").innerHTML = matching.slice(0, 50).map(node => `<button type="button" data-search-node="${escapeAttribute(node.id)}">${escapeHtml(node.title)}</button>`).join("")
    + (query && !matching.length ? `<p>No puzzles found.</p>` : matching.length > 50 ? `<p>${matching.length - 50} more results. Refine your search.</p>` : "");
  must<HTMLButtonElement>("#clear-focus").hidden = !focusNodeIds;
  must<HTMLElement>("#focus-banner").hidden = !focusNodeIds;
  must<HTMLElement>("#focus-count").textContent = focusNodeIds ? `Focused view: ${visibleNodes().length} of ${nodes.length} puzzles` : "";
}

function simulationAvailableNodes(): Set<string> | null {
  return simulationActive ? new Set(dependencyModel().available(completedNodeIds)) : null;
}

function simulationNodeClass(id: string, available: ReadonlySet<string> | null) {
  return !available ? "" : completedNodeIds.has(id) ? " simulation-complete"
    : available.has(id) ? " simulation-available" : " simulation-blocked";
}

function completionCross(id: string) {
  return simulationActive && completedNodeIds.has(id)
    ? `<svg class="completion-cross" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M 4 4 L 96 96 M 96 4 L 4 96" vector-effect="non-scaling-stroke" /></svg>` : "";
}

function renderSimulation() {
  const panel = must<HTMLElement>("#simulation-panel");
  panel.hidden = !simulationActive;
  if (!simulationActive) return;
  completedNodeIds = dependencyModel().validCompleted(completedNodeIds);
  const available = dependencyModel().available(completedNodeIds);
  const blocked = nodes.length - completedNodeIds.size - available.length;
  panel.innerHTML = `<p role="status">${completedNodeIds.size} solved · ${available.length} available · ${blocked} blocked</p>
    <p class="field-help">Solve puzzles on the chart; use Undo to reopen them.</p>
    <div class="simulation-list">${available.map(id => `<button type="button" data-solve="${escapeAttribute(id)}">Solve: ${escapeHtml(getNode(id)?.title ?? id)}</button>`).join("")}</div>
    ${!available.length && blocked ? `<p>No available puzzles. Check for circular locks.</p>` : ""}
    <button type="button" id="reset-simulation">Reset playthrough</button>`;
}

function toggleCompleted(id: string) {
  if (completedNodeIds.has(id)) completedNodeIds.delete(id);
  else if (dependencyModel().canSolve(id, completedNodeIds)) completedNodeIds.add(id);
  completedNodeIds = dependencyModel().validCompleted(completedNodeIds);
  render();
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

function graphDiagnostics(analysis: GraphAnalysis): GraphDiagnostic[] {
  const diagnostics: GraphDiagnostic[] = [];
  if (analysis.topology.hasCycle) diagnostics.push({ key: "cycle", message: "Cycle detected. Select to inspect the circular dependencies.", ids: [...dependencyModel().cycleNodes()] });
  if (!analysis.roots.length && nodes.length) diagnostics.push({ key: "no-roots", message: "No root nodes. The player may have no starting puzzle.", ids: nodes.map(node => node.id) });
  analysis.leaves.filter(node => node.kind !== "reward").forEach(node => diagnostics.push({ key: JSON.stringify(["leaf", node.id]), message: `Non-reward leaf: ${node.title}.`, ids: [node.id] }));
  analysis.topology.layers.forEach((layer, index) => {
    if (layer.length > 5) diagnostics.push({ key: `broad-layer:${index}`, message: `Broad layer: ${layer.length} puzzles.`, ids: layer.map(node => node.id) });
  });
  dependencyModel().narrativeIssues().forEach(issue => diagnostics.push({
    key: JSON.stringify(["narrative", issue.nodeId, issue.referenceId]),
    message: `${getNode(issue.nodeId)?.title}: ${issue.missing ? "missing" : "unguaranteed"} narrative reference to ${getNode(issue.referenceId)?.title ?? issue.referenceId}.`,
    ids: [issue.nodeId, ...(issue.missing ? [] : [issue.referenceId])],
  }));
  if (routingError) diagnostics.push({ key: "routing", message: `Connection routing error: ${routingError}`, ids: [] });
  if (!analysis.bottlenecks.length && nodes.length > 3) diagnostics.push({ key: "no-closers", message: "No closers yet. Consider where branches intentionally collapse.", ids: [] });
  return diagnostics;
}

function clearDiagnosticSelection() {
  selectedDiagnosticKeys.clear();
  diagnosticNodeIds.clear();
  diagnosticEdgeIds.clear();
}

function reconcileDiagnosticSelection(diagnostics: GraphDiagnostic[]) {
  const active = diagnostics.filter(item => item.ids.length && selectedDiagnosticKeys.has(item.key));
  selectedDiagnosticKeys = new Set(active.map(item => item.key));
  diagnosticNodeIds = new Set(active.flatMap(item => item.ids));
  diagnosticEdgeIds = new Set(edges
    .filter(edge => diagnosticNodeIds.has(edge.from) && diagnosticNodeIds.has(edge.to))
    .map(edge => edge.id));
}

function applyDiagnosticHighlights(root: ParentNode = document) {
  const active = selectedDiagnosticKeys.size > 0;
  root.querySelectorAll<HTMLElement | SVGElement>(".node, .edge-group, .group-box, .pacing-bar").forEach(element => {
    const highlighted = active && (element.matches(".edge-group")
      ? diagnosticEdgeIds.has(element.dataset.edgeId ?? "")
      : diagnosticNodeIds.has(element.dataset.nodeId ?? ""));
    element.classList.toggle("check-highlighted", highlighted);
    element.classList.toggle("check-dimmed", active && !highlighted);
  });
}

function toggleDiagnostic(key: string) {
  const analysis = analyzeGraph();
  const diagnostics = graphDiagnostics(analysis);
  if (selectedDiagnosticKeys.has(key)) selectedDiagnosticKeys.delete(key);
  else selectedDiagnosticKeys.add(key);
  reconcileDiagnosticSelection(diagnostics);
  if (diagnosticNodeIds.size) inspectNodes(diagnosticNodeIds);
  else {
    clearSelection();
    focusNodeIds = null;
    render();
  }
  renderWarnings(analysis);
}

function renderWarnings(analysis: GraphAnalysis) {
  const diagnostics = graphDiagnostics(analysis);
  reconcileDiagnosticSelection(diagnostics);
  const focusedKey = (document.activeElement as HTMLElement | null)?.dataset.diagnostic;
  warningsPanel.innerHTML = diagnostics.length ? diagnostics.map(item => item.ids.length
    ? `<button class="warning-item diagnostic" data-diagnostic="${escapeAttribute(item.key)}" type="button" aria-pressed="${selectedDiagnosticKeys.has(item.key)}"><span class="diagnostic-indicator" aria-hidden="true"></span><span>${escapeHtml(item.message)}</span></button>`
    : `<p class="warning-item">${escapeHtml(item.message)}</p>`).join("")
    : `<p class="empty-state">No structural warnings in this chart.</p>`;
  warningsPanel.querySelectorAll<HTMLButtonElement>("[data-diagnostic]").forEach(button => {
    button.addEventListener("click", () => toggleDiagnostic(button.dataset.diagnostic!));
    if (button.dataset.diagnostic === focusedKey) button.focus({ preventScroll: true });
  });
  applyDiagnosticHighlights();
}

function renderPacingView(analysis: GraphAnalysis) {
  const available = simulationAvailableNodes();
  if (nodes.length === 0) {
    pacingBoard.innerHTML = `
      <div class="pacing-empty">
        <h2>Pacing</h2>
        <p>Add puzzle nodes and dependencies to see the adventure pacing map.</p>
      </div>
    `;
    return;
  }

  const layerCount = Math.max(1, analysis.topology.layers.length);
  const lanes = buildPacingLanes(analysis);
  const bars = buildPacingBars(analysis, lanes, layerCount);
  const barsByLane = new Map<string, PacingBar[]>(lanes.map(lane => [lane.id, []]));
  bars.forEach(bar => barsByLane.get(bar.laneId)?.push(bar));
  const layerWidths = Array.from({ length: layerCount }, (_, index) => analysis.topology.layers[index]?.length ?? 0);
  const widestLayerWidth = maxOf(layerWidths, 0);
  const widestLayer = layerWidths.indexOf(widestLayerWidth);
  const criticalPath = criticalPathForAnalysis(analysis);
  const nonRewardLeaves = analysis.leaves.filter((node) => node.kind !== "reward");
  const rewardLeaves = analysis.leaves.filter((node) => node.kind === "reward");
  const notes = pacingNotes(analysis, widestLayer + 1, criticalPath, nonRewardLeaves);

  pacingBoard.style.setProperty("--layer-count", `${layerCount}`);
  pacingBoard.innerHTML = `
    <section class="pacing-summary" aria-label="Pacing summary">
      <div class="pacing-stat">
        <span>Widest Layer</span>
        <strong>${widestLayerWidth}</strong>
        <small>L${widestLayer + 1} ${escapeHtml(layerPressureLabel(widestLayerWidth))}</small>
      </div>
      <div class="pacing-stat">
        <span>Closers</span>
        <strong>${analysis.bottlenecks.length}</strong>
        <small>${analysis.bottlenecks.length === 1 ? "resync point" : "resync points"}</small>
      </div>
      <div class="pacing-stat">
        <span>Critical Path</span>
        <strong>${criticalPath.length}</strong>
        <small>${escapeHtml(criticalPathLabel(criticalPath))}</small>
      </div>
      <div class="pacing-stat">
        <span>Loose Leaves</span>
        <strong>${nonRewardLeaves.length}</strong>
        <small>${rewardLeaves.length} reward ${rewardLeaves.length === 1 ? "leaf" : "leaves"}</small>
      </div>
    </section>

    <section class="pacing-notes" aria-label="Adventure pacing signals">
      <h2>Adventure Signals</h2>
      <div class="pacing-note-list">
        ${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
      </div>
    </section>

    <section class="pacing-timeline" aria-label="Puzzle availability by dependency layer">
      <div class="pacing-header-row">
        <div class="pacing-lane-heading">Thread</div>
        ${layerWidths
          .map(
            (width, index) => `
              <div class="pacing-layer-heading">
                <strong>L${index + 1}</strong>
                <span>${width} ${width === 1 ? "node" : "nodes"}</span>
              </div>
            `,
          )
          .join("")}
      </div>
      ${lanes
        .map((lane) => renderPacingLane(lane, barsByLane.get(lane.id) ?? [], layerCount, available))
        .join("")}
    </section>
  `;

  pacingBoard.querySelectorAll<HTMLButtonElement>(".pacing-bar").forEach((button) => {
    button.addEventListener("click", () => {
      const nodeId = button.dataset.nodeId;

      if (!nodeId) {
        return;
      }

      selectOnlyNode(nodeId);
      render();
    });
  });
  applyDiagnosticHighlights(pacingBoard);
}

function renderPacingLane(lane: PacingLane, bars: PacingBar[], layerCount: number, available: ReadonlySet<string> | null) {
  const trackCount = Math.max(1, maxOf(bars.map((bar) => bar.track + 1), 1));
  const nodeCount = bars.length;

  return `
    <div class="pacing-lane" style="--lane-tracks: ${trackCount}; --lane-color: ${escapeAttribute(lane.color)};">
      <div class="pacing-lane-label">
        <span class="pacing-lane-color" aria-hidden="true"></span>
        <strong title="${escapeAttribute(lane.name)}">${escapeHtml(lane.name)}</strong>
        <small>${nodeCount} ${nodeCount === 1 ? "node" : "nodes"}</small>
      </div>
      ${Array.from({ length: layerCount }, (_, index) => `<div class="pacing-cell" style="grid-column: ${index + 2}; grid-row: 1 / span ${trackCount};"></div>`).join("")}
      ${bars.map((bar) => renderPacingBar(bar, available)).join("")}
    </div>
  `;
}

function renderPacingBar(bar: PacingBar, available: ReadonlySet<string> | null) {
  const selected = (selectedNodeIds.has(bar.node.id) ? " selected" : "") + simulationNodeClass(bar.node.id, available);
  const title = `${bar.node.title}: ${bar.role}. Layers ${bar.startLayer + 1}-${bar.endLayer + 1}. ${bar.incoming} in, ${bar.outgoing} out.`;
  const difficulty = typeof bar.node.difficulty === "number" ? ` · D${bar.node.difficulty}` : "";

  return `
    <button
      class="pacing-bar node-${bar.node.kind}${selected}"
      type="button"
      data-node-id="${escapeAttribute(bar.node.id)}"
      title="${escapeAttribute(title)}"
      style="grid-column: ${bar.startLayer + 2} / ${bar.endLayer + 3}; grid-row: ${bar.track + 1}; --node-color: ${escapeAttribute(nodeColor(bar.node))};"
    >
      ${completionCross(bar.node.id)}
      <span class="pacing-bar-title">${escapeHtml(bar.node.title)}</span>
      <span class="pacing-bar-meta">${escapeHtml(bar.role)} · ${bar.incoming} in · ${bar.outgoing} out${difficulty}</span>
    </button>
  `;
}

function buildPacingLanes(analysis: GraphAnalysis): PacingLane[] {
  const assignedNodeIds = new Set<string>();
  const lanes: PacingLane[] = [];

  groups.forEach((group) => {
    const laneNodes = group.nodeIds
      .map((nodeId) => getNode(nodeId))
      .filter((node): node is PuzzleNode => node !== undefined && !assignedNodeIds.has(node.id) && (!focusNodeIds || focusNodeIds.has(node.id)));

    if (laneNodes.length === 0) {
      return;
    }

    laneNodes.forEach((node) => assignedNodeIds.add(node.id));
    lanes.push({
      id: `group:${group.id}`,
      name: group.name.trim() || "Untitled group",
      color: groupColor(group),
      nodes: laneNodes,
    });
  });

  const ungroupedNodes = nodes.filter((node) => !assignedNodeIds.has(node.id) && (!focusNodeIds || focusNodeIds.has(node.id)));

  if (ungroupedNodes.length > 0) {
    lanes.push({
      id: "ungrouped",
      name: "Ungrouped",
      color: defaultGroupColor(lanes.length + 1),
      nodes: ungroupedNodes,
    });
  }

  return lanes.sort((a, b) => laneStartLayer(a, analysis) - laneStartLayer(b, analysis) || a.name.localeCompare(b.name));
}

function buildPacingBars(analysis: GraphAnalysis, lanes: PacingLane[], layerCount: number): PacingBar[] {
  const bars: PacingBar[] = [];

  for (const lane of lanes) {
    const laneBars = lane.nodes
      .map((node) => {
        const startLayer = analysis.topology.layerByNode.get(node.id) ?? 0;
        const childLayers = outgoingEdges(node.id)
          .map((edge) => analysis.topology.layerByNode.get(edge.to))
          .filter((layer): layer is number => typeof layer === "number");
        const endLayer =
          childLayers.length > 0
            ? Math.max(startLayer, maxOf(childLayers, startLayer))
            : Math.max(startLayer, layerCount - 1);

        return {
          node,
          laneId: lane.id,
          startLayer,
          endLayer,
          track: 0,
          incoming: incomingEdges(node.id).length,
          outgoing: outgoingEdges(node.id).length,
          role: designRoleForNode(node),
        };
      })
      .sort((a, b) => a.startLayer - b.startLayer || a.endLayer - b.endLayer || compareNodesByPosition(a.node, b.node));

    const trackEnds: number[] = [];

    for (const bar of laneBars) {
      const track = trackEnds.findIndex((endLayer) => endLayer < bar.startLayer);
      const assignedTrack = track === -1 ? trackEnds.length : track;
      bar.track = assignedTrack;
      trackEnds[assignedTrack] = bar.endLayer;
      bars.push(bar);
    }
  }

  return bars;
}

function laneStartLayer(lane: PacingLane, analysis: GraphAnalysis) {
  return minOf(lane.nodes.map((node) => analysis.topology.layerByNode.get(node.id) ?? 0), 0);
}

function designRoleForNode(node: PuzzleNode) {
  const incoming = incomingEdges(node.id).length;
  const outgoing = outgoingEdges(node.id).length;
  const isRoot = incoming === 0;
  const isLeaf = outgoing === 0;

  if (isLeaf && node.kind === "reward") {
    return "Reward";
  }

  if (isLeaf) {
    return "Loose leaf";
  }

  if (incoming >= 2 && outgoing >= 2) {
    return "Hinge";
  }

  if (incoming >= 2) {
    return "Closer";
  }

  if (isRoot || outgoing >= 2) {
    return "Opener";
  }

  return incoming === 1 && outgoing === 1 ? "Chain" : labelForKind(node.kind);
}

function criticalPathForAnalysis(analysis: GraphAnalysis) {
  if (analysis.topology.hasCycle) return [];
  if (nodes.length === 0) {
    return [];
  }

  const bestByNode = new Map<string, { length: number; parentId: string | null }>();

  for (const node of analysis.topology.order) {
    const bestParent = incomingEdges(node.id)
      .map((edge) => ({
        nodeId: edge.from,
        length: bestByNode.get(edge.from)?.length ?? 0,
      }))
      .sort((a, b) => node.prerequisiteMode === "any" ? a.length - b.length : b.length - a.length)[0];

    bestByNode.set(node.id, {
      length: (bestParent?.length ?? 0) + 1,
      parentId: bestParent?.nodeId ?? null,
    });
  }

  const endNodeId = [...bestByNode.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0];

  if (!endNodeId) {
    return [];
  }

  const path: PuzzleNode[] = [];
  let cursor: string | null = endNodeId;

  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = getNode(cursor);

    if (node) {
      path.unshift(node);
    }

    cursor = bestByNode.get(cursor)?.parentId ?? null;
  }

  return path;
}

function pacingNotes(
  analysis: GraphAnalysis,
  widestLayer: number,
  criticalPath: PuzzleNode[],
  nonRewardLeaves: PuzzleNode[],
) {
  const notes: string[] = [];

  if (analysis.maxLayerWidth <= 1 && nodes.length > 2) {
    notes.push("Mostly linear structure: one stuck puzzle can stop the player cold unless the intent is a tight sequence.");
  } else if (analysis.maxLayerWidth > 5) {
    notes.push(`Layer ${widestLayer} is broad: freedom is high, but dialogue, hints, state tracking, and QA combinations get expensive.`);
  } else {
    notes.push("Layer width is in a manageable range for parallel adventure-game work.");
  }

  if (analysis.bottlenecks.length > 0) {
    notes.push("Closers are narrative resync points: they are good places to retire inventory, move acts, or safely reference prior events.");
  } else if (nodes.length > 3) {
    notes.push("No closers yet: the chart may need a milestone where parallel threads intentionally collapse.");
  }

  if (criticalPath.length > 4) {
    notes.push(`Longest chain has ${criticalPath.length} steps: check whether that stretch offers enough side work while players are stuck.`);
  }

  if (nonRewardLeaves.length > 0) {
    notes.push("Loose leaves should usually become rewards, optional content, or feed another puzzle.");
  }

  return notes;
}

function layerPressureLabel(width: number) {
  if (width <= 1) {
    return "linear";
  }

  if (width <= 3) {
    return "focused";
  }

  if (width <= 5) {
    return "broad";
  }

  return "heavy";
}

function criticalPathLabel(path: PuzzleNode[]) {
  if (path.length === 0) {
    return "none";
  }

  if (path.length === 1) {
    return path[0].title;
  }

  return `${path[0].title} -> ${path[path.length - 1].title}`;
}

function renderInspector() {
  const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const selectedEdge = selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) : null;
  const selectedGroup = selectedGroupId ? groups.find((group) => group.id === selectedGroupId) : null;

  if (selectedGroup) {
    const selectedIds = new Set(selectedGroup.nodeIds);
    const memberCount = selectedGroup.nodeIds.filter((nodeId) => getNode(nodeId)).length;
    const incoming = edges.filter((edge) => !selectedIds.has(edge.from) && selectedIds.has(edge.to)).length;
    const outgoing = edges.filter((edge) => selectedIds.has(edge.from) && !selectedIds.has(edge.to)).length;
    const internal = edges.filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to)).length;
    const visibilityIcon = selectedGroup.hidden ? "eye" : "eye-off";
    const visibilityLabel = selectedGroup.hidden ? "Show Group" : "Hide Group";
    const color = groupColor(selectedGroup);

    inspector.innerHTML = `
      <div class="field-group">
        <label for="group-name">Group Name</label>
        <input id="group-name" value="${escapeAttribute(selectedGroup.name)}" />
      </div>
      <div class="field-group">
        <label for="group-color">Color</label>
        <div class="color-control">
          <input id="group-color" type="color" value="${escapeAttribute(color)}" />
          <span id="group-color-value">${escapeHtml(color.toUpperCase())}</span>
        </div>
      </div>
      <div class="relationship-list">
        <h3>Contents</h3>
        <p>${memberCount} nodes</p>
        <h3>External Prerequisites</h3>
        <p>${incoming}</p>
        <h3>External Unlocks</h3>
        <p>${outgoing}</p>
        <h3>Internal Dependencies</h3>
        <p>${internal}</p>
      </div>
      <div class="edge-layout-actions">
        <button class="secondary-button icon-button" id="toggle-group-hidden" type="button" title="${visibilityLabel}">
          <i data-lucide="${visibilityIcon}"></i>
          <span>${visibilityLabel}</span>
        </button>
        <button class="secondary-button icon-button" id="ungroup-selection" type="button" title="Ungroup selected group">
          <i data-lucide="ungroup"></i>
          <span>Ungroup</span>
        </button>
      </div>
      <button class="danger-button" id="delete-group" type="button" title="Delete group and contained nodes">
        <i data-lucide="trash-2"></i>
        <span>Delete Group Contents</span>
      </button>
    `;

    bindGroupInspector(selectedGroup.id);
    return;
  }

  if (selectedNodes.length > 1) {
    const selectedIds = new Set(selectedNodes.map((node) => node.id));
    const incoming = edges.filter((edge) => !selectedIds.has(edge.from) && selectedIds.has(edge.to)).length;
    const outgoing = edges.filter((edge) => selectedIds.has(edge.from) && !selectedIds.has(edge.to)).length;
    const internal = edges.filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to)).length;

    inspector.innerHTML = `
      <div class="relationship-list">
        <h3>Selection</h3>
        <p>${selectedNodes.length} nodes</p>
        <h3>External Prerequisites</h3>
        <p>${incoming}</p>
        <h3>External Unlocks</h3>
        <p>${outgoing}</p>
        <h3>Internal Dependencies</h3>
        <p>${internal}</p>
      </div>
      <button class="secondary-button icon-button full-width-action" id="create-group" type="button" title="Create a group from selected nodes">
        <i data-lucide="group"></i>
        <span>Create Group</span>
      </button>
      <button class="danger-button" id="delete-selection" type="button" title="Delete selected nodes">
        <i data-lucide="trash-2"></i>
        <span>Delete Nodes</span>
      </button>
    `;

    must<HTMLButtonElement>("#create-group").addEventListener("click", () => {
      createGroupFromSelection();
    });
    must<HTMLButtonElement>("#delete-selection").addEventListener("click", () => {
      deleteSelection();
    });
    return;
  }

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
      <div class="field-group"><label for="prerequisite-mode">Prerequisite rule</label>
        <select id="prerequisite-mode"><option value="all" ${selectedNode.prerequisiteMode !== "any" ? "selected" : ""}>All prerequisites (AND)</option>
        <option value="any" ${selectedNode.prerequisiteMode === "any" ? "selected" : ""}>Any prerequisite (OR)</option></select>
      </div>
      <div class="focus-actions"><button type="button" id="focus-upstream">Focus prerequisites</button>
        <button type="button" id="focus-downstream">Focus unlocks</button></div>
      ${simulationActive ? `<button type="button" id="simulation-node-action" ${!completedNodeIds.has(selectedNode.id) && !dependencyModel().canSolve(selectedNode.id, completedNodeIds) ? "disabled" : ""}>${completedNodeIds.has(selectedNode.id) ? "Undo completion" : "Mark solved"}</button>` : ""}
      <div class="relationship-list">
        <h3>Prerequisites</h3>
        <p>${escapeHtml(prerequisites || "Available at chart start.")}</p>
        <h3>Unlocks</h3>
        <p>${escapeHtml(unlocks || "No downstream puzzle yet.")}</p>
        <h3>Safe narrative context</h3>
        <p>${escapeHtml(safeFacts.length > 0 ? safeFacts.join(", ") : "Only always-known facts are guaranteed.")}</p>
      </div>
      <div class="field-group"><label for="narrative-reference">Narrative references</label>
        <p class="field-help">Tag events this puzzle's writing assumes have happened.</p>
        <select id="narrative-reference"><option value="">Choose an event…</option>${nodes.filter(node => node.id !== selectedNode.id && !selectedNode.narrativeReferences?.includes(node.id)).map(node => `<option value="${escapeAttribute(node.id)}">${escapeHtml(node.title)}</option>`).join("")}</select>
        <div class="reference-list">${(selectedNode.narrativeReferences ?? []).map(id => `<button type="button" data-remove-reference="${escapeAttribute(id)}" title="Remove reference">${escapeHtml(getNode(id)?.title ?? id)} · ${dependencyModel().guaranteedAncestors(selectedNode.id).has(id) ? "guaranteed" : "not guaranteed"} ×</button>`).join("")}</div>
      </div>
      <button class="danger-button" id="delete-selection" type="button" title="Delete selected node">
        <i data-lucide="trash-2"></i>
        <span>Delete Node</span>
      </button>
    `;

    bindNodeInspector(selectedNode.id);
    return;
  }

  if (selectedEdge) {
    const routeReset = selectedEdge.manualRoute
      ? `<button class="secondary-button" id="reset-edge-route" type="button" title="Reset dependency route">Reset Route</button>`
      : "";
    const labelReset =
      typeof selectedEdge.manualLabelPosition === "number"
        ? `<button class="secondary-button" id="reset-edge-label" type="button" title="Reset dependency label position">Reset Label</button>`
        : "";
    const layoutActions =
      routeReset || labelReset ? `<div class="edge-layout-actions">${routeReset}${labelReset}</div>` : "";

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
      ${layoutActions}
      <button class="danger-button" id="delete-selection" type="button" title="Delete selected dependency">
        <i data-lucide="trash-2"></i>
        <span>Delete Edge</span>
      </button>
    `;

    bindEdgeInspector(selectedEdge.id);
    return;
  }

  const chartTitle = currentGraph?.title ?? "Untitled Graph";
  const chartDescription = currentGraph?.description ?? "";
  const sourceName = currentGraph?.sourceName ?? "Unsaved graph";

  inspector.innerHTML = `
    <div class="chart-inspector">
      <div class="field-group">
        <label for="chart-title">Chart Name</label>
        <input id="chart-title" value="${escapeAttribute(chartTitle)}" />
      </div>
      <div class="field-group">
        <label for="chart-description">Description</label>
        <textarea id="chart-description" placeholder="Project notes, scope, source, or design memo.">${escapeHtml(chartDescription)}</textarea>
      </div>
      <div class="relationship-list">
        <h3>File</h3>
        <p>${escapeHtml(sourceName)}</p>
        <h3>Contents</h3>
        <p>${nodes.length} nodes, ${edges.length} dependencies, ${groups.length} groups</p>
      </div>
      <div class="inspector-empty compact">
        <i data-lucide="mouse-pointer-2"></i>
        <p>Select a puzzle node, group, or dependency arrow to edit chart objects.</p>
      </div>
    </div>
  `;

  bindChartInspector();
}

function bindChartInspector() {
  const titleInput = must<HTMLInputElement>("#chart-title");
  const descriptionInput = must<HTMLTextAreaElement>("#chart-description");

  bindGraphEditTransaction(titleInput);
  bindGraphEditTransaction(descriptionInput);

  titleInput.addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value;
    updateChartMetadata({ title: value });
    renderWelcome();
  });

  descriptionInput.addEventListener("input", (event) => {
    const value = (event.target as HTMLTextAreaElement).value;
    updateChartMetadata({ description: value });
  });
}

function bindNodeInspector(nodeId: string) {
  must<HTMLSelectElement>("#prerequisite-mode").addEventListener("change", event => withGraphEdit(() => {
    updateNode(nodeId, { prerequisiteMode: (event.target as HTMLSelectElement).value === "any" ? "any" : "all" }); render();
  }));
  for (const direction of ["upstream", "downstream"] as const) {
    must<HTMLButtonElement>(`#focus-${direction}`).addEventListener("click", () => focusOnNodes([nodeId, ...dependencyModel().related(nodeId, direction)], nodeId));
  }
  document.querySelector("#simulation-node-action")?.addEventListener("click", () => toggleCompleted(nodeId));
  must<HTMLSelectElement>("#narrative-reference").addEventListener("change", event => {
    const id = (event.target as HTMLSelectElement).value;
    if (id) withGraphEdit(() => { updateNode(nodeId, { narrativeReferences: [...getNode(nodeId)?.narrativeReferences ?? [], id] }); render(); });
  });
  inspector.querySelectorAll<HTMLButtonElement>("[data-remove-reference]").forEach(button => button.addEventListener("click", () => withGraphEdit(() => {
    updateNode(nodeId, { narrativeReferences: getNode(nodeId)?.narrativeReferences?.filter(id => id !== button.dataset.removeReference) }); render();
  })));

  const titleInput = must<HTMLInputElement>("#node-title");
  const kindSelect = must<HTMLSelectElement>("#node-kind");
  const colorInput = must<HTMLInputElement>("#node-color");
  const difficultyInput = must<HTMLInputElement>("#node-difficulty");
  const noteInput = must<HTMLTextAreaElement>("#node-note");

  bindGraphEditTransaction(titleInput);
  bindGraphEditTransaction(colorInput);
  bindGraphEditTransaction(difficultyInput);
  bindGraphEditTransaction(noteInput);

  titleInput.addEventListener("input", (event) => {
    updateNode(nodeId, { title: (event.target as HTMLInputElement).value });
    refreshDerivedViews();
  });

  kindSelect.addEventListener("change", (event) => {
    withGraphEdit(() => {
      updateNode(nodeId, { kind: (event.target as HTMLSelectElement).value as NodeKind });
      render();
    });
  });

  colorInput.addEventListener("input", (event) => {
    const color = sanitizeColor((event.target as HTMLInputElement).value);
    updateNode(nodeId, { color });
    must<HTMLSpanElement>("#node-color-value").textContent = color.toUpperCase();
    refreshDerivedViews();
  });

  difficultyInput.addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value.trim();
    const parsed = Number(value);
    const difficulty = value === "" || !Number.isFinite(parsed) ? undefined : clamp(parsed, 1, 5);
    updateNode(nodeId, { difficulty });
    refreshDerivedViews();
  });

  noteInput.addEventListener("input", (event) => {
    updateNode(nodeId, { note: (event.target as HTMLTextAreaElement).value });
    refreshDerivedViews();
  });

  must<HTMLButtonElement>("#delete-selection").addEventListener("click", () => {
    deleteSelection();
  });
}

function bindEdgeInspector(edgeId: string) {
  const labelInput = must<HTMLInputElement>("#edge-label");
  const tokenSelect = must<HTMLSelectElement>("#edge-token-type");

  bindGraphEditTransaction(labelInput);

  labelInput.addEventListener("input", (event) => {
    updateEdge(edgeId, { label: (event.target as HTMLInputElement).value });
      renderEdges();
  });

  tokenSelect.addEventListener("change", (event) => {
    withGraphEdit(() => {
      updateEdge(edgeId, {
        tokenType: (event.target as HTMLSelectElement).value as DependencyEdge["tokenType"],
      });
      render();
    });
  });

  inspector.querySelector<HTMLButtonElement>("#reset-edge-route")?.addEventListener("click", async () => {
    const session = documentSession;
    const choice = await graphChoice("Reset this connector?", "Discard this connector's manual waypoints and return to automatic routing? You can undo it afterward.", [["cancel", "Cancel"], ["reset", "Reset route"]]);
    if (choice === "reset" && session === documentSession) withGraphEdit(() => { clearEdgeRouteOverride(edgeId); render(); });
  });

  inspector.querySelector<HTMLButtonElement>("#reset-edge-label")?.addEventListener("click", async () => {
    const session = documentSession;
    const choice = await graphChoice("Reset label position?", "Return this label to its automatic position? You can undo it afterward.", [["cancel", "Cancel"], ["reset", "Reset label"]]);
    if (choice === "reset" && session === documentSession) withGraphEdit(() => { clearEdgeLabelOverride(edgeId); render(); });
  });

  must<HTMLButtonElement>("#delete-selection").addEventListener("click", () => {
    deleteSelection();
  });
}

function bindGroupInspector(groupId: string) {
  const nameInput = must<HTMLInputElement>("#group-name");
  const colorInput = must<HTMLInputElement>("#group-color");

  bindGraphEditTransaction(nameInput);
  bindGraphEditTransaction(colorInput);

  nameInput.addEventListener("input", (event) => {
    updateGroup(groupId, { name: (event.target as HTMLInputElement).value });
    renderGroups();
    refreshDerivedViews();
  });

  colorInput.addEventListener("input", (event) => {
    const color = sanitizeColor((event.target as HTMLInputElement).value);
    updateGroup(groupId, { color });
    must<HTMLSpanElement>("#group-color-value").textContent = color.toUpperCase();
    renderGroups();
    refreshDerivedViews();
  });

  must<HTMLButtonElement>("#toggle-group-hidden").addEventListener("click", () => {
    toggleGroupHidden(groupId);
  });

  must<HTMLButtonElement>("#ungroup-selection").addEventListener("click", () => {
    ungroup(groupId);
  });

  must<HTMLButtonElement>("#delete-group").addEventListener("click", () => {
    void deleteGroupWithConfirmation(groupId);
  });
}

function bindGraphEditTransaction(element: HTMLElement) {
  element.addEventListener("focus", () => {
    beginGraphEdit();
  });

  element.addEventListener("input", () => {
    beginGraphEdit();
  });

  element.addEventListener("change", () => {
    commitGraphEdit();
  });

  element.addEventListener("blur", () => {
    commitGraphEdit();
  });
}

function beginSelectionBox(event: PointerEvent, point: Point) {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  selectionBoxState = {
    start: point,
    current: point,
    additive: isSelectionModifier(event),
    initialNodeIds: new Set(selectedNodeIds),
    hasMoved: false,
  };

  window.addEventListener("pointermove", handleSelectionBoxMove);
  window.addEventListener("pointerup", finishSelectionBox, { once: true });
}

function handleSelectionBoxMove(event: PointerEvent) {
  if (!selectionBoxState) {
    return;
  }

  selectionBoxState.current = getCanvasPoint(event.clientX, event.clientY);
  selectionBoxState.hasMoved ||= distanceBetween(selectionBoxState.start, selectionBoxState.current) > 4;

  if (!selectionBoxState.hasMoved) {
    return;
  }

  const selectedByBox = nodesInRect(rectFromPoints(selectionBoxState.start, selectionBoxState.current));
  const nextSelection = selectionBoxState.additive
    ? new Set([...selectionBoxState.initialNodeIds, ...selectedByBox])
    : new Set(selectedByBox);

  setSelectedNodes(nextSelection);
  renderNodes();
  renderEdges();
  renderInspector();
  renderSelectionBox();
}

function finishSelectionBox() {
  const state = selectionBoxState;
  selectionBoxState = null;
  window.removeEventListener("pointermove", handleSelectionBoxMove);

  if (state && !state.hasMoved && !state.additive) {
    clearSelection();
  }

  renderSelectionBox();
  render();
}

function nodesInRect(rect: Rect) {
  return visibleNodes()
    .filter((node) =>
      rectsIntersect(rect, {
        left: node.x,
        top: node.y,
        right: node.x + node.width,
        bottom: node.y + node.height,
      }),
    )
    .map((node) => node.id);
}

function rectFromPoints(start: Point, end: Point): Rect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

function rectsIntersect(a: Rect, b: Rect) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function handleGroupPointerDown(event: PointerEvent, groupId: string) {
  if (activeTool === "node") {
    const point = getCanvasPoint(event.clientX, event.clientY);
    const ghostPosition = nodeGhostPosition ?? positionNodeForPlacement(point.x - 105, point.y - 58);
    addNodeAt(ghostPosition.x, ghostPosition.y);
    return;
  }

  if (activeTool !== "select" || event.button !== 0) {
    selectOnlyGroup(groupId);
    render();
    return;
  }

  const group = getGroup(groupId);
  const bounds = group ? groupBounds(group) : null;

  selectOnlyGroup(groupId);

  if (!group || !bounds) {
    render();
    return;
  }

  const originPositions = group.nodeIds
    .map((nodeId) => getNode(nodeId))
    .filter((node): node is PuzzleNode => node !== undefined)
    .map((node) => ({
      nodeId: node.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }));

  if (originPositions.length === 0) {
    render();
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);
  event.preventDefault();
  beginGraphEdit();
  groupDragState = {
    groupId,
    startPoint: point,
    originBounds: bounds,
    originPositions,
    offsetX: point.x - bounds.left,
    offsetY: point.y - bounds.top,
  };

  window.addEventListener("pointermove", handleGroupDragMove);
  window.addEventListener("pointerup", finishGroupDrag, { once: true });
  render();
}

function handleGroupDragMove(event: PointerEvent) {
  if (!groupDragState) {
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);
  const targetLeft = snapToGrid ? snapCoordinate(point.x - groupDragState.offsetX) : point.x - groupDragState.offsetX;
  const targetTop = snapToGrid ? snapCoordinate(point.y - groupDragState.offsetY) : point.y - groupDragState.offsetY;
  const desiredDelta = {
    x: targetLeft - groupDragState.originBounds.left,
    y: targetTop - groupDragState.originBounds.top,
  };
  const delta = clampGroupDragDelta(desiredDelta, groupDragState.originPositions);
  const positionsByNodeId = new Map(
    groupDragState.originPositions.map((position) => [
      position.nodeId,
      {
        x: position.x + delta.x,
        y: position.y + delta.y,
      },
    ]),
  );

  if (!applyDraggedPositions(positionsByNodeId)) return;
  renderDraggedPositions(positionsByNodeId);

  if (visibleEdges().length > 0) {
    scheduleEdgePreview();
  } else {
    renderEdges();
  }
}

function finishGroupDrag() {
  groupDragState = null;
  cancelScheduledEdgePreview();
  window.removeEventListener("pointermove", handleGroupDragMove);
  render();
  commitGraphEdit();
}

function beginEdgeRouteDrag(event: PointerEvent, edgeId: string) {
  const edge = getEdge(edgeId);
  const route = edge ? routeForEdge(edge) : null;

  selectOnlyEdge(edgeId);

  if (!edge || !route) {
    render();
    return;
  }

  const points = routePointsForEdge(edge, pathPointsFromSvgPath(route.path));
  const point = getCanvasPoint(event.clientX, event.clientY);
  const segmentIndex = points ? nearestRouteSegmentIndex(point, points) : null;

  if (!points || segmentIndex === null) {
    render();
    return;
  }

  event.preventDefault();
  beginGraphEdit();
  edgeRouteDragState = {
    edgeId,
    segmentIndex,
    orientation: segmentOrientation(points[segmentIndex], points[segmentIndex + 1]),
    startPoint: point,
    originalPoints: points,
  };

  window.addEventListener("pointermove", handleEdgeRouteDragMove);
  window.addEventListener("pointerup", finishEdgeRouteDrag, { once: true });
  render();
}

function handleEdgeRouteDragMove(event: PointerEvent) {
  if (!edgeRouteDragState) {
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);
  const nextPoints = movedRoutePoints(edgeRouteDragState, point);
  updateEdge(edgeRouteDragState.edgeId, { manualRoute: nextPoints });
  renderEdges();
}

function finishEdgeRouteDrag() {
  edgeRouteDragState = null;
  window.removeEventListener("pointermove", handleEdgeRouteDragMove);
  render();
  commitGraphEdit();
}

function beginEdgeLabelDrag(event: PointerEvent, edgeId: string) {
  const edge = getEdge(edgeId);
  const route = edge ? routeForEdge(edge) : null;

  selectOnlyEdge(edgeId);

  if (!edge || !route) {
    render();
    return;
  }

  const points = pathPointsFromSvgPath(route.path);

  if (points.length < 2) {
    render();
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);
  const routeLabelPoint = { x: route.labelX, y: route.labelY };
  const originalPosition =
    typeof edge.manualLabelPosition === "number"
      ? edge.manualLabelPosition
      : nearestPolylinePosition(routeLabelPoint, points);

  event.preventDefault();
  beginGraphEdit();
  edgeLabelDragState = {
    edgeId,
    originalPosition,
    startPointerPosition: nearestPolylinePosition(point, points),
  };

  window.addEventListener("pointermove", handleEdgeLabelDragMove);
  window.addEventListener("pointerup", finishEdgeLabelDrag, { once: true });
  render();
}

function handleEdgeLabelDragMove(event: PointerEvent) {
  if (!edgeLabelDragState) {
    return;
  }

  const edge = getEdge(edgeLabelDragState.edgeId);
  const route = edge ? routeForEdge(edge) : null;

  if (!edge || !route) {
    return;
  }

  const points = pathPointsFromSvgPath(route.path);

  if (points.length < 2) {
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);
  const pointerPosition = nearestPolylinePosition(point, points);
  const manualLabelPosition = clamp(
    edgeLabelDragState.originalPosition + pointerPosition - edgeLabelDragState.startPointerPosition,
    0,
    1,
  );

  updateEdge(edgeLabelDragState.edgeId, { manualLabelPosition });
  renderEdges();
}

function finishEdgeLabelDrag() {
  edgeLabelDragState = null;
  window.removeEventListener("pointermove", handleEdgeLabelDragMove);
  render();
  commitGraphEdit();
}

function handleNodePointerDown(event: PointerEvent, nodeId: string) {
  if (activeTool === "connect") {
    if (!pendingConnectionFrom) {
      selectOnlyNode(nodeId);
      pendingConnectionFrom = nodeId;
      render();
      return;
    }

    addDependency(pendingConnectionFrom, nodeId);
    return;
  }

  if (isSelectionModifier(event)) {
    toggleNodeSelection(nodeId);
    render();
    return;
  }

  if (selectedNodeIds.has(nodeId)) {
    selectedNodeId = nodeId;
    selectedEdgeId = null;
  } else {
    selectOnlyNode(nodeId);
  }

  pendingConnectionFrom = null;

  const node = getNode(nodeId);

  if (!node) {
    return;
  }

  const point = getCanvasPoint(event.clientX, event.clientY);
  const nodeIds = selectedNodeIds.has(nodeId) ? [...selectedNodeIds] : [nodeId];
  const originPositions = nodeIds
    .map((selectedId) => getNode(selectedId))
    .filter((selectedNode): selectedNode is PuzzleNode => selectedNode !== undefined)
    .map((selectedNode) => ({
      nodeId: selectedNode.id,
      x: selectedNode.x,
      y: selectedNode.y,
      width: selectedNode.width,
      height: selectedNode.height,
    }));

  beginGraphEdit();

  dragState = {
    primaryNodeId: nodeId,
    nodeIds: originPositions.map((position) => position.nodeId),
    startPoint: point,
    originPositions,
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
  const primaryOrigin = dragState.originPositions.find((position) => position.nodeId === dragState?.primaryNodeId);

  if (!primaryOrigin) {
    return;
  }

  const primaryPosition = positionNodeForDrag(point.x - dragState.offsetX, point.y - dragState.offsetY);
  const desiredDelta = {
    x: primaryPosition.x - primaryOrigin.x,
    y: primaryPosition.y - primaryOrigin.y,
  };
  const delta = clampGroupDragDelta(desiredDelta, dragState.originPositions);
  const positionsByNodeId = new Map(
    dragState.originPositions.map((position) => [
      position.nodeId,
      {
        x: position.x + delta.x,
        y: position.y + delta.y,
      },
    ]),
  );

  if (!applyDraggedPositions(positionsByNodeId)) return;
  renderDraggedPositions(positionsByNodeId);

  if (visibleEdges().length > 0) {
    scheduleEdgePreview();
  } else {
    renderEdges();
  }
}

function finishDrag() {
  dragState = null;
  cancelScheduledEdgePreview();
  window.removeEventListener("pointermove", handleDragMove);
  render();
  commitGraphEdit();
}

function updateNode(nodeId: string, patch: Partial<PuzzleNode>) {
  if (["x", "y", "width", "height"].some(key => key in patch)) invalidateAutomaticRoutes();
  nodes = nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node));
  noteGraphChanged();
}

function updateEdge(edgeId: string, patch: Partial<DependencyEdge>) {
  if (["from", "to", "label", "manualRoute"].some(key => key in patch)) invalidateAutomaticRoutes();
  edges = edges.map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge));
  noteGraphChanged();
}

function updateGroup(groupId: string, patch: Partial<PuzzleGroup>) {
  groups = groups.map((group) => (group.id === groupId ? { ...group, ...patch } : group));
  noteGraphChanged();
}

function updateChartMetadata(patch: { title?: string; description?: string }) {
  if (!currentGraph) {
    return;
  }

  currentGraph = {
    ...currentGraph,
    ...(typeof patch.title === "string" ? { title: patch.title } : {}),
    ...(typeof patch.description === "string"
      ? { description: patch.description.trim() ? patch.description : undefined }
      : {}),
  };
  noteGraphChanged();
}

function clearEdgeRouteOverride(edgeId: string) {
  invalidateAutomaticRoutes();
  edges = edges.map((edge) => {
    if (edge.id !== edgeId) {
      return edge;
    }

    const next = { ...edge };
    delete next.manualRoute;
    return next;
  });
}

function clearEdgeLabelOverride(edgeId: string) {
  edges = edges.map((edge) => {
    if (edge.id !== edgeId) {
      return edge;
    }

    const next = { ...edge };
    delete next.manualLabelPosition;
    return next;
  });
}

function getEdge(edgeId: string) {
  ensureEdgeAdjacency();
  return edgesById.get(edgeId);
}

function getGroup(groupId: string) {
  return groups.find((group) => group.id === groupId);
}

function visibleNodes() {
  return nodes.filter((node) => !isNodeHidden(node.id) && (!focusNodeIds || focusNodeIds.has(node.id)));
}

function visibleEdges() {
  return edges.filter((edge) => !isNodeHidden(edge.from) && !isNodeHidden(edge.to) &&
    (!focusNodeIds || (focusNodeIds.has(edge.from) && focusNodeIds.has(edge.to))));
}

function isNodeHidden(nodeId: string) {
  if (focusNodeIds?.has(nodeId)) return false;
  return groups.some((group) => group.hidden && group.nodeIds.includes(nodeId));
}

function groupBounds(group: PuzzleGroup): Rect | null {
  const groupNodes = group.nodeIds
    .filter((id) => !focusNodeIds || focusNodeIds.has(id))
    .map((nodeId) => getNode(nodeId))
    .filter((node): node is PuzzleNode => node !== undefined);

  if (groupNodes.length === 0) {
    return null;
  }

  const left = Math.max(0, minOf(groupNodes.map((node) => node.x), 0) - GROUP_PADDING_X);
  const top = Math.max(0, minOf(groupNodes.map((node) => node.y), 0) - GROUP_PADDING_TOP);
  const right = Math.min(
    world.width,
    Math.max(left + 180, maxOf(groupNodes.map((node) => node.x + node.width), left) + GROUP_PADDING_X),
  );
  const bottom = Math.min(
    world.height,
    Math.max(top + 132, maxOf(groupNodes.map((node) => node.y + node.height), top) + GROUP_PADDING_BOTTOM),
  );

  return {
    left,
    top,
    right,
    bottom,
  };
}


function invalidateAutomaticRoutes(positionsOnly = false) {
  automaticRoutesDirty = true;
  routingRevision += 1;
  if (!positionsOnly) routingContentRevision += 1;
}

function routingDragActive() {
  // Moving boxes uses the same live router as release. Editing a manual
  // connector must not start an automatic routing job underneath the gesture.
  return !!edgeRouteDragState;
}

function refreshAutomaticRoutesIfNeeded() {
  if (currentGraph && automaticRoutesDirty && !routingDragActive()) void ensureAutomaticRouting();
}

async function ensureAutomaticRouting(): Promise<void> {
  if (automaticRoutingPromise) return automaticRoutingPromise;
  if (!currentGraph || !automaticRoutesDirty || routingDragActive()) return;
  automaticRoutingPromise = (async () => {
    while (currentGraph && automaticRoutesDirty && !routingDragActive()) {
      if (!edges.some(edge => !edge.manualRoute)) { automaticRoutesDirty = false; break; }
      const session = documentSession;
      const revision = routingRevision;
      const contentRevision = routingContentRevision;
      const engine = await initializeLayoutEngine();
      if (!engine) { automaticRoutesDirty = false; break; }
      if (session !== documentSession || revision !== routingRevision) continue;
      const inputNodes = nodes.map(node => ({ ...node }));
      const inputEdges = edges.map(edge => ({ ...edge }));
      try {
        const geometry = await engine.layout(inputNodes, inputEdges, "fixed");
        // Coalesce pointer movements into one in-flight calculation. A result
        // for an earlier position can refresh the live preview while the next
        // position is calculated, but never crosses a file or content change.
        if (session !== documentSession || contentRevision !== routingContentRevision) continue;
        if (revision !== routingRevision && !dragState && !groupDragState) continue;
        automaticRoutes = decorateRoutedLayout(geometry);
        routingError = null;
        automaticRoutesDirty = revision !== routingRevision;
        resizeWorld(Math.max(world.width, automaticRoutes.width), Math.max(world.height, automaticRoutes.height));
      } catch (error) {
        if (session !== documentSession || revision !== routingRevision) continue;
        routingError = error instanceof Error ? error.message : "Unable to route connections.";
        automaticRoutesDirty = false;
      }
      renderEdges();
      renderGroups();
      renderWarnings(analyzeGraph());
    }
  })();
  try { await automaticRoutingPromise; }
  finally { automaticRoutingPromise = null; }
}

async function initializeLayoutEngine(): Promise<D2LayoutEngine | null> {
  if (layoutEngine) return layoutEngine;
  if (layoutEngineLoadPromise) return layoutEngineLoadPromise;
  layoutEngineLoadPromise = (async () => {
    try {
      layoutEngine = await loadLayoutEngine();
      return layoutEngine;
    } catch (error) {
      routingError = error instanceof Error ? error.message : "Unable to load the connection router.";
      return null;
    } finally { layoutEngineLoadPromise = null; }
  })();
  return layoutEngineLoadPromise;
}

// Paint port-preserving feedback immediately, then replace it with a D2 result
// during the drag. Release reuses that result if the positions haven't changed.
function scheduleEdgePreview() {
  invalidateAutomaticRoutes(true);
  if (edgePreviewHandle !== null) return;
  edgePreviewHandle = window.requestAnimationFrame(() => {
    edgePreviewHandle = null;
    const movedIds = dragState?.nodeIds ?? groupDragState?.originPositions.map(position => position.nodeId) ?? [];
    const affected = new Set(movedIds.flatMap(id => [...incomingEdges(id), ...outgoingEdges(id)].map(edge => edge.id)));
    renderEdges(affected);
  });
}

function applyDraggedPositions(positions: Map<string, Point>) {
  let moved = false;
  nodes = nodes.map(node => {
    const position = positions.get(node.id);
    if (!position || (node.x === position.x && node.y === position.y)) return node;
    moved = true;
    return { ...node, ...position };
  });
  return moved;
}

function renderDraggedPositions(positions: Map<string, Point>) {
  nodeLayer.querySelectorAll<HTMLElement>(".node").forEach(element => {
    const point = positions.get(element.dataset.nodeId ?? "");
    if (point) { element.style.left = `${point.x}px`; element.style.top = `${point.y}px`; }
  });
  groupLayer.querySelectorAll<HTMLElement>(".group-box").forEach(element => {
    const group = getGroup(element.dataset.groupId ?? "");
    if (!group?.nodeIds.some(id => positions.has(id))) return;
    const bounds = groupBounds(group);
    if (!bounds) return;
    Object.assign(element.style, { left: `${bounds.left}px`, top: `${bounds.top}px`,
      width: `${bounds.right-bounds.left}px`, height: `${bounds.bottom-bounds.top}px` });
  });
}

function cancelScheduledEdgePreview() {
  if (edgePreviewHandle !== null) {
    window.cancelAnimationFrame(edgePreviewHandle);
    edgePreviewHandle = null;
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

async function computeRoutedLayout(mode: LayoutMode): Promise<RoutedLayout> {
  if (!layoutEngine) throw new Error("The connection router is not loaded.");
  const geometry = await layoutEngine.layout(nodes.map(node => ({ ...node })), edges.map(edge => ({ ...edge })), mode);
  const layout = decorateRoutedLayout(geometry);
  if (mode === "fixed") return layout;
  const left = minOf([...layout.nodes.values()].map(node => node.x), 0);
  const top = minOf([...layout.nodes.values()].map(node => node.y), 0);
  return translateRoutedLayout(layout, { x: 64 - left, y: 64 - top });
}

function decorateRoutedLayout(geometry: LayoutGeometry): RoutedLayout {
  const parsedNodes = new Map<string, RoutedNodeLayout>();
  const parsedEdges = new Map<string, RoutedEdgeLayout>();
  const edgeGeometries: Array<{ edgeId: string; pathPoints: Point[]; arrowPoints: Point[]; labelPoint: Point }> = [];
  geometry.nodes.forEach(node => parsedNodes.set(node.id, {
    ...node, center: { x: node.x + node.width / 2, y: node.y + node.height / 2 },
  }));
  geometry.edges.forEach((points, edgeId) => {
    const pathPoints = compactRoutePoints(points);
    edgeGeometries.push({ edgeId, pathPoints, arrowPoints: arrowForRoute(pathPoints), labelPoint: pointAtPolylinePosition(pathPoints, 0.5) });
  });
  const nodeObstacles = new RectangleIndex<{ rect: Rect }>();
  parsedNodes.forEach(node => nodeObstacles.add({ rect: inflateRect({ left: node.x, top: node.y, right: node.x + node.width, bottom: node.y + node.height }, 10) }));
  const labelObstacles = new RectangleIndex<{ rect: Rect }>();
  const obstacleIndex = new RectangleIndex<{ edgeId: string; rect: Rect }>();
  edgeGeometries.forEach(geometry => edgePathObstacleRects(geometry.pathPoints).forEach(rect => obstacleIndex.add({ edgeId: geometry.edgeId, rect })));
  for (const geometry of edgeGeometries) {
    const source = getEdge(geometry.edgeId);
    const hasLabel = !!source?.label.trim();
    const bounds = inflateRect({ left: minOf(geometry.pathPoints.map(p => p.x), 0), top: minOf(geometry.pathPoints.map(p => p.y), 0),
      right: maxOf(geometry.pathPoints.map(p => p.x), 0), bottom: maxOf(geometry.pathPoints.map(p => p.y), 0) }, EDGE_LABEL_MAX_WIDTH);
    const otherEdgeObstacleRects = hasLabel ? obstacleIndex.query(bounds).filter(item => item.edgeId !== geometry.edgeId).map(item => item.rect) : [];
    const labelPoint = fitLabelPoint(
      geometry.edgeId,
      geometry.labelPoint,
      geometry.pathPoints,
      hasLabel ? nodeObstacles.query(bounds).map(item => item.rect) : [],
      otherEdgeObstacleRects,
      hasLabel ? labelObstacles.query(bounds).map(item => item.rect) : [],
    );
    const sourceEdge = edges.find((edge) => edge.id === geometry.edgeId);
    const label = sourceEdge?.label.trim() ?? "";

    if (label) {
      labelObstacles.add({ rect: inflateRect(labelRect(labelPoint, measureEdgeLabel(label)), EDGE_LABEL_CLEARANCE) });
    }

    parsedEdges.set(geometry.edgeId, {
      path: orthogonalPath(geometry.pathPoints),
      arrowPoints: geometry.arrowPoints,
      labelX: labelPoint.x,
      labelY: labelPoint.y,
    });
  }

  return {
    ...measureWorldSize(parsedNodes, parsedEdges),
    nodes: parsedNodes,
    edges: parsedEdges,
  };
}

function fitLabelPoint(
  edgeId: string,
  defaultPoint: Point,
  pathPoints: Point[],
  nodeRects: Rect[],
  edgeObstacleRects: Rect[],
  placedLabelRects: Rect[],
) {
  const sourceEdge = edges.find((edge) => edge.id === edgeId);
  const label = sourceEdge?.label.trim() ?? "";
  const labelMetrics = measureEdgeLabel(label);

  if (!label) {
    return defaultPoint;
  }

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

  return edges
    .filter((edge) => edge.label.trim())
    .map((edge) => {
      const route = routeForEdge(edge);

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

function translateRoutedLayout(layout: RoutedLayout, offset: Point): RoutedLayout {
  const translatedNodes = new Map<string, RoutedNodeLayout>();
  const translatedEdges = new Map<string, RoutedEdgeLayout>();

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
  return {
    width: measured.width,
    height: measured.height,
    nodes: translatedNodes,
    edges: translatedEdges,
  };
}

function measureWorldSize(
  layoutNodes: Map<string, RoutedNodeLayout>,
  layoutEdges: Map<string, RoutedEdgeLayout>,
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
    width: Math.ceil(maxOf(xs, EMPTY_GRAPH_WORLD.width)),
    height: Math.ceil(maxOf(ys, EMPTY_GRAPH_WORLD.height)),
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
  graphSpace.style.setProperty("--graph-emphasis-scale", String(Math.min(6, Math.max(1, 1 / zoom))));
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

  return minOf(candidates.map((candidate) => distanceBetween(point, candidate)), Number.POSITIVE_INFINITY);
}

function orthogonalPath(points: Point[]) {
  if (points.length === 0) {
    return "";
  }

  const routePoints = points.filter((point, index) => {
    const previous = points[index - 1];

    return !previous || distanceBetween(previous, point) > 0.1;
  });
  const commands = [`M ${round(routePoints[0].x)} ${round(routePoints[0].y)}`];

  for (const point of routePoints.slice(1)) {
    commands.push(`L ${round(point.x)} ${round(point.y)}`);
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

  if (routingError) {
    warnings.push(`Connection routing error: ${routingError}`);
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

let topologyNodes: PuzzleNode[] | null = null;
let topologyEdges: DependencyEdge[] | null = null;
let cachedTopology: Topology;
function getTopology(): Topology {
  if (topologyNodes !== nodes || topologyEdges !== edges) {
    cachedTopology = computeTopology();
    topologyNodes = nodes; topologyEdges = edges;
  }
  return cachedTopology;
}

function computeTopology(): Topology {
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  nodes.forEach((node) => {
    inDegree.set(node.id, 0);
    children.set(node.id, []);
  });

  edges.forEach((edge) => {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    children.get(edge.from)?.push(edge.to);
  });

  // Kahn's algorithm, always emitting the position-smallest currently-available
  // node. We walk the queue with a head index instead of shift() (no O(N) splice
  // per step) and only re-sort the unprocessed tail when new nodes become ready,
  // which preserves the exact ordering the renderer relied on.
  const queue = nodes
    .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
    .sort(compareNodesByPosition);
  const order: PuzzleNode[] = [];
  let head = 0;

  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    order.push(node);
    let addedReadyNode = false;

    for (const childId of children.get(node.id) ?? []) {
      const nextDegree = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, nextDegree);

      if (nextDegree === 0) {
        const child = getNode(childId);

        if (child) {
          queue.push(child);
          addedReadyNode = true;
        }
      }
    }

    if (addedReadyNode && head < queue.length) {
      const tail = queue.slice(head).sort(compareNodesByPosition);

      for (let index = 0; index < tail.length; index += 1) {
        queue[head + index] = tail[index];
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
    const layer = parentLayers.length === 0 ? 0 : (node.prerequisiteMode === "any" ? minOf(parentLayers, 0) : maxOf(parentLayers, 0)) + 1;
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

function dependencyModel() {
  if (modelNodes !== nodes || modelEdges !== edges) {
    cachedModel = new DependencyModel(nodes, edges);
    modelNodes = nodes;
    modelEdges = edges;
  }
  return cachedModel;
}

function getAncestors(nodeId: string) {
  return [...dependencyModel().guaranteedAncestors(nodeId)]
    .map(id => getNode(id)).filter((node): node is PuzzleNode => !!node).sort(compareNodesByPosition);
}

// Graph lookups are memoized on the identity of the `nodes`/`edges` arrays.
// Every mutation in this module replaces those arrays wholesale (never edits in
// place), so an identity check is enough to know the cache is still valid. This
// turns getNode/incoming/outgoing from O(N)/O(E) scans into O(1) map lookups,
// which matters because they are called inside per-node render and analysis loops.
const EMPTY_EDGES: readonly DependencyEdge[] = Object.freeze([]);

let nodeIndexSource: PuzzleNode[] | null = null;
let nodeIndexValue = new Map<string, PuzzleNode>();
let edgeAdjacencySource: DependencyEdge[] | null = null;
let incomingEdgeMap = new Map<string, DependencyEdge[]>();
let outgoingEdgeMap = new Map<string, DependencyEdge[]>();
let edgesById = new Map<string, DependencyEdge>();

function nodeIndex() {
  if (nodeIndexSource !== nodes) {
    nodeIndexValue = new Map(nodes.map((node) => [node.id, node]));
    nodeIndexSource = nodes;
  }

  return nodeIndexValue;
}

function ensureEdgeAdjacency() {
  if (edgeAdjacencySource === edges) {
    return;
  }

  incomingEdgeMap = new Map();
  outgoingEdgeMap = new Map();
  edgesById = new Map();

  for (const edge of edges) {
    edgesById.set(edge.id, edge);
    const outgoing = outgoingEdgeMap.get(edge.from);
    if (outgoing) {
      outgoing.push(edge);
    } else {
      outgoingEdgeMap.set(edge.from, [edge]);
    }

    const incoming = incomingEdgeMap.get(edge.to);
    if (incoming) {
      incoming.push(edge);
    } else {
      incomingEdgeMap.set(edge.to, [edge]);
    }
  }

  edgeAdjacencySource = edges;
}

function getNode(nodeId: string) {
  return nodeIndex().get(nodeId);
}

// The returned arrays are shared cache entries; callers treat them as read-only
// (verified: no caller mutates the result in place — they map/filter/reduce).
function incomingEdges(nodeId: string): readonly DependencyEdge[] {
  ensureEdgeAdjacency();
  return incomingEdgeMap.get(nodeId) ?? EMPTY_EDGES;
}

function outgoingEdges(nodeId: string): readonly DependencyEdge[] {
  ensureEdgeAdjacency();
  return outgoingEdgeMap.get(nodeId) ?? EMPTY_EDGES;
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

function positionNodeForPlacement(x: number, y: number): Point {
  if (!snapToGrid) {
    return clampNodePosition(x, y);
  }

  return {
    x: snapCoordinateWithin(x, 40, world.width - 260),
    y: snapCoordinateWithin(y, 60, world.height - 180),
  };
}

function positionNodeForDrag(x: number, y: number): Point {
  if (!snapToGrid) {
    return {
      x: clamp(x, 30, world.width - 250),
      y: clamp(y, 42, world.height - 150),
    };
  }

  return {
    x: snapCoordinateWithin(x, 30, world.width - 250),
    y: snapCoordinateWithin(y, 42, world.height - 150),
  };
}

function clampGroupDragDelta(
  delta: Point,
  positions: Array<{ x: number; y: number; width: number; height: number }>,
): Point {
  if (positions.length === 0) {
    return delta;
  }

  const minDeltaX = maxOf(positions.map((position) => 30 - position.x), Number.NEGATIVE_INFINITY);
  const maxDeltaX = minOf(
    positions.map((position) => world.width - Math.max(250, position.width + 40) - position.x),
    Number.POSITIVE_INFINITY,
  );
  const minDeltaY = maxOf(positions.map((position) => 42 - position.y), Number.NEGATIVE_INFINITY);
  const maxDeltaY = minOf(
    positions.map((position) => world.height - Math.max(150, position.height + 32) - position.y),
    Number.POSITIVE_INFINITY,
  );

  return {
    x: clamp(delta.x, minDeltaX, maxDeltaX),
    y: clamp(delta.y, minDeltaY, maxDeltaY),
  };
}

function snapCoordinate(value: number) {
  return Math.round(value / SNAP_GRID_SIZE) * SNAP_GRID_SIZE;
}

function snapCoordinateWithin(value: number, min: number, max: number) {
  const snapped = snapCoordinate(clamp(value, min, max));

  if (snapped < min) {
    return Math.ceil(min / SNAP_GRID_SIZE) * SNAP_GRID_SIZE;
  }

  if (snapped > max) {
    return Math.floor(max / SNAP_GRID_SIZE) * SNAP_GRID_SIZE;
  }

  return snapped;
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
  const legacyActByNodeId = legacyActMap(record.nodes, normalizedNodes);
  const nodeIds = new Set(normalizedNodes.map((node) => node.id));
  const normalizedEdges = record.edges
    .map((edge) => normalizeGraphEdge(edge))
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const explicitGroups = Array.isArray(record.groups)
    ? record.groups
        .map((group) => normalizeGraphGroup(group, nodeIds))
        .filter((group) => group.nodeIds.length > 0)
    : [];
  const normalizedGroups = groupsWithLegacyActs(explicitGroups, normalizedNodes, legacyActByNodeId, normalizedEdges);
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
    groups: normalizedGroups,
  };
}

function normalizeGraphNode(value: unknown): PuzzleNode {
  const record = asRecord(value, "Graph node must be an object.");
  const id = stringValue(record.id, "");

  if (!id) {
    throw new Error("Graph node is missing an id.");
  }

  const kind = isNodeKind(record.kind) ? record.kind : "puzzle";
  const difficulty = optionalDifficulty(record.difficulty);

  return {
    id,
    title: stringValue(record.title, "Untitled puzzle"),
    note: stringValue(record.note, ""),
    kind,
    color: sanitizeColor(stringValue(record.color, defaultNodeColor(kind))),
    difficulty,
    prerequisiteMode: record.prerequisiteMode === "any" ? "any" : "all",
    narrativeReferences: Array.isArray(record.narrativeReferences)
      ? [...new Set(record.narrativeReferences.filter((id): id is string => typeof id === "string" && id.length > 0))] : [],
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

  const edge: DependencyEdge = {
    id,
    from,
    to,
    label: stringValue(record.label, ""),
    tokenType: isTokenType(record.tokenType) ? record.tokenType : "item",
  };

  const manualRoute = optionalPointArray(record.manualRoute);
  const manualLabelPosition = optionalUnitNumber(record.manualLabelPosition);

  if (manualRoute) {
    edge.manualRoute = manualRoute;
  }

  if (typeof manualLabelPosition === "number") {
    edge.manualLabelPosition = manualLabelPosition;
  }

  return edge;
}

function normalizeGraphGroup(value: unknown, knownNodeIds: Set<string>): PuzzleGroup {
  const record = asRecord(value, "Graph group must be an object.");
  const id = stringValue(record.id, "");

  if (!id) {
    throw new Error("Graph group is missing an id.");
  }

  const rawNodeIds = Array.isArray(record.nodeIds) ? record.nodeIds : [];
  const nodeIds = [...new Set(rawNodeIds.map((nodeId) => stringValue(nodeId, "")).filter((nodeId) => knownNodeIds.has(nodeId)))];

  return {
    id,
    name: stringValue(record.name, "Untitled group"),
    color: sanitizeColor(stringValue(record.color, defaultGroupColor(1))),
    nodeIds,
    hidden: record.hidden === true,
  };
}

function legacyActMap(rawNodes: unknown[], normalizedNodes: PuzzleNode[]) {
  const actByNodeId = new Map<string, string>();

  rawNodes.forEach((rawNode, index) => {
    if (!isRecord(rawNode)) {
      return;
    }

    const act = optionalString(rawNode.act)?.trim();
    const node = normalizedNodes[index];

    if (act && node) {
      actByNodeId.set(node.id, act);
    }
  });

  return actByNodeId;
}

function groupsWithLegacyActs(
  explicitGroups: PuzzleGroup[],
  graphNodes: PuzzleNode[],
  legacyActByNodeId: Map<string, string>,
  graphEdges: DependencyEdge[],
) {
  const visibleGroups = splitBeginningEndingGroups(explicitGroups, graphNodes, graphEdges);

  if (legacyActByNodeId.size === 0) {
    return visibleGroups;
  }

  const groupsByName = new Map(visibleGroups.map((group) => [group.name.trim().toLowerCase(), group]));
  const assignedNodeIds = new Set(visibleGroups.flatMap((group) => group.nodeIds));
  const nextGroups = visibleGroups.map(cloneGroup);
  const nextGroupsByName = new Map(nextGroups.map((group) => [group.name.trim().toLowerCase(), group]));
  const usedGroupIds = new Set(nextGroups.map((group) => group.id));

  graphNodes.forEach((node) => {
    const rawAct = legacyActByNodeId.get(node.id);
    const act = rawAct ? visibleGroupNameForLegacyAct(rawAct, node, graphEdges) : undefined;

    if (!act) {
      return;
    }

    const key = act.toLowerCase();
    const matchingExplicitGroup = groupsByName.get(key);

    if (!matchingExplicitGroup && assignedNodeIds.has(node.id)) {
      return;
    }

    let group = nextGroupsByName.get(key);

    if (!group) {
      group = {
        id: uniqueGroupId(`g-${slugify(act) || "legacy-act"}`, usedGroupIds),
        name: act,
        color: legacyActGroupColor(act, graphNodes, legacyActByNodeId, graphEdges),
        nodeIds: [],
        hidden: false,
      };
      nextGroups.push(group);
      nextGroupsByName.set(key, group);
      usedGroupIds.add(group.id);
    }

    if (!group.nodeIds.includes(node.id)) {
      group.nodeIds.push(node.id);
    }
  });

  return nextGroups.filter((group) => group.nodeIds.length > 0);
}

function splitBeginningEndingGroups(
  graphGroups: PuzzleGroup[],
  graphNodes: PuzzleNode[],
  graphEdges: DependencyEdge[],
) {
  const splitGroups: PuzzleGroup[] = [];
  const usedGroupIds = new Set(graphGroups.map((group) => group.id));

  graphGroups.forEach((group) => {
    if (!isBeginningEndingName(group.name)) {
      splitGroups.push(cloneGroup(group));
      return;
    }

    const beginningNodeIds: string[] = [];
    const endingNodeIds: string[] = [];

    group.nodeIds.forEach((nodeId) => {
      const node = graphNodes.find((candidate) => candidate.id === nodeId);

      if (!node) {
        return;
      }

      if (beginningEndingGroupNameForNode(node, graphEdges) === "Beginning") {
        beginningNodeIds.push(nodeId);
      } else {
        endingNodeIds.push(nodeId);
      }
    });

    if (beginningNodeIds.length > 0) {
      splitGroups.push({
        ...group,
        id: uniqueGroupId("g-beginning", usedGroupIds),
        name: "Beginning",
        color: "#d72a15",
        nodeIds: beginningNodeIds,
      });
      usedGroupIds.add(splitGroups[splitGroups.length - 1].id);
    }

    if (endingNodeIds.length > 0) {
      splitGroups.push({
        ...group,
        id: uniqueGroupId("g-ending", usedGroupIds),
        name: "Ending",
        color: "#7f6699",
        nodeIds: endingNodeIds,
      });
      usedGroupIds.add(splitGroups[splitGroups.length - 1].id);
    }
  });

  return splitGroups;
}

function visibleGroupNameForLegacyAct(act: string, node: PuzzleNode, graphEdges: DependencyEdge[]) {
  return isBeginningEndingName(act) ? beginningEndingGroupNameForNode(node, graphEdges) : act;
}

function isBeginningEndingName(name: string) {
  return name.trim().toLowerCase() === "beginning / ending";
}

function beginningEndingGroupNameForNode(node: PuzzleNode, graphEdges: DependencyEdge[]) {
  const normalizedTitle = node.title.trim().toLowerCase();
  const incoming = graphEdges.filter((edge) => edge.to === node.id).length;

  return incoming === 0 || /\b(begin|start|opening|intro)\b/.test(normalizedTitle) ? "Beginning" : "Ending";
}

function legacyActGroupColor(
  act: string,
  graphNodes: PuzzleNode[],
  legacyActByNodeId: Map<string, string>,
  graphEdges: DependencyEdge[],
) {
  const fallbackColors: Record<string, string> = {
    beginning: "#d72a15",
    "beginning / ending": "#d72a15",
    bernard: "#6395dc",
    ending: "#7f6699",
    hoagie: "#f19c49",
    laverne: "#008d00",
  };
  const semanticColor = fallbackColors[act.toLowerCase()];

  if (semanticColor) {
    return semanticColor;
  }

  const firstNodeColor = graphNodes.find((node) => {
    const rawAct = legacyActByNodeId.get(node.id);

    return rawAct ? visibleGroupNameForLegacyAct(rawAct, node, graphEdges) === act : false;
  })?.color;

  if (firstNodeColor) {
    return firstNodeColor;
  }

  return defaultGroupColor(1);
}

function uniqueGroupId(baseId: string, usedGroupIds: Set<string>) {
  let candidate = baseId;
  let suffix = 2;

  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function rememberGraph(document: GraphDocumentV1, sourceName: string, filePath?: string) {
  const openedAt = new Date().toISOString();
  const id = recentGraphId(document.title, sourceName, filePath);
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

function forgetRecentGraph(recentId: string) {
  recentGraphs = recentGraphs.filter((recent) => recent.id !== recentId);
  saveRecentGraphs();
  renderWelcome();
  hydrateIcons();
}

function clearRecentGraphs() {
  recentGraphs = [];
  saveRecentGraphs();
  renderWelcome();
  hydrateIcons();
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
            id: stringValue(value.id, recentGraphId(title, sourceName, filePath)),
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

function loadSnapToGrid() {
  try {
    return localStorage.getItem(SNAP_TO_GRID_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function setSnapToGrid(nextSnapToGrid: boolean) {
  snapToGrid = nextSnapToGrid;

  try {
    localStorage.setItem(SNAP_TO_GRID_STORAGE_KEY, String(snapToGrid));
  } catch {
    // The editor preference can still work for this session without storage.
  }

  if (activeTool === "node" && nodeGhostPosition) {
    nodeGhostPosition = positionNodeForPlacement(nodeGhostPosition.x, nodeGhostPosition.y);
    renderNodeGhost();
  }

  updateSnapGridControl();
}

function updateSnapGridControl() {
  snapGridButton.classList.toggle("active", snapToGrid);
  snapGridButton.setAttribute("aria-pressed", String(snapToGrid));
  snapGridButton.title = snapToGrid ? "Snap to grid is on" : "Snap to grid is off";
}

function applyTheme(nextTheme: ThemeMode) {
  document.documentElement.dataset.theme = nextTheme;
  themeToggle.setAttribute("aria-pressed", String(nextTheme === "dark"));
  themeToggle.title = nextTheme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  themeToggle.setAttribute("aria-label", themeToggle.title);
  themeLabel.textContent = nextTheme === "dark" ? "Dark" : "Light";
}

function saveRecentGraphs() {
  // Each entry embeds a full graph document, so a few large graphs can blow the
  // ~5MB localStorage quota. Rather than dropping the whole list on a quota
  // error, retry with progressively fewer (most-recent-first) entries so the
  // newest graphs still persist.
  for (let limit = recentGraphs.length; limit >= 0; limit -= 1) {
    try {
      localStorage.setItem(RECENT_GRAPHS_STORAGE_KEY, JSON.stringify(recentGraphs.slice(0, limit)));
      return;
    } catch {
      // Try again with one fewer entry; if even an empty list fails, storage is
      // unavailable and recents are simply not persisted this session.
    }
  }
}

function cloneGraphDocument(document: GraphDocumentV1): GraphDocumentV1 {
  return JSON.parse(JSON.stringify(document)) as GraphDocumentV1;
}

function cloneEdge(edge: DependencyEdge): DependencyEdge {
  return {
    ...edge,
    manualRoute: edge.manualRoute?.map((point) => ({ ...point })),
  };
}

function cloneGroup(group: PuzzleGroup): PuzzleGroup {
  return {
    ...group,
    nodeIds: [...group.nodeIds],
  };
}


// When a file path is known it is the stable identity for a recent entry, so
// editing the chart title (or re-saving) updates the existing entry instead of
// spawning a duplicate. Only fall back to source-name + title when there is no
// path (e.g. browser downloads).
function recentGraphId(title: string, sourceName: string, filePath?: string) {
  return (filePath && filePath.trim() ? filePath : `${sourceName}::${title}`).toLowerCase();
}

function measureGraphBounds(graphNodes: PuzzleNode[], graphEdges: DependencyEdge[] = []) {
  const xs = graphNodes.map(node => node.x + node.width + 220);
  const ys = graphNodes.map(node => node.y + node.height + 220);
  graphEdges.forEach(edge => edge.manualRoute?.forEach(point => { xs.push(point.x + 220); ys.push(point.y + 220); }));
  return {
    width: Math.ceil(maxOf(xs, EMPTY_GRAPH_WORLD.width)),
    height: Math.ceil(maxOf(ys, EMPTY_GRAPH_WORLD.height)),
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

function optionalUnitNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : undefined;
}

function optionalPointArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const points = value
    .map((point) => {
      if (!isRecord(point)) {
        return null;
      }

      const x = typeof point.x === "number" && Number.isFinite(point.x) ? point.x : null;
      const y = typeof point.y === "number" && Number.isFinite(point.y) ? point.y : null;

      return x === null || y === null ? null : { x, y };
    })
    .filter((point): point is Point => point !== null);

  return points.length >= 2 ? points : undefined;
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

function defaultNodeColor(kind: NodeKind) {
  const colors: Record<NodeKind, string> = {
    puzzle: "#549aa3",
    gate: "#c18b2c",
    reward: "#7f6699",
  };

  return colors[kind];
}

function defaultGroupColor(serial = 1) {
  const colors = ["#006a6a", "#6c5d8f", "#8c5a00", "#7a4d7c", "#2f6b3f", "#8a4b3e"];

  return colors[(Math.max(1, serial) - 1) % colors.length];
}

function nodeColor(node: PuzzleNode) {
  return sanitizeColor(node.color || defaultNodeColor(node.kind));
}

function groupColor(group: PuzzleGroup) {
  return sanitizeColor(group.color || defaultGroupColor(1));
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

// Reduce-based min/max. Spreading a large array into Math.min/Math.max
// (`Math.max(...points)`) throws a RangeError once the argument count gets big,
// so these are used on any array whose length scales with the graph size. The
// fallback is returned only for an empty array; otherwise the accumulator is
// seeded from the first element so a real extremum is always found.
function maxOf(values: number[], fallback: number) {
  if (values.length === 0) {
    return fallback;
  }

  let result = values[0];

  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > result) {
      result = values[index];
    }
  }

  return result;
}

function minOf(values: number[], fallback: number) {
  if (values.length === 0) {
    return fallback;
  }

  let result = values[0];

  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < result) {
      result = values[index];
    }
  }

  return result;
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
      Eye,
      EyeOff,
      FilePlus2,
      FolderOpen,
      GitBranchPlus,
      Group: GroupIcon,
      History,
      House,
      Layers3,
      Magnet,
      Maximize2,
      Moon,
      MousePointer2,
      PanelRight,
      Redo2,
      Save,
      SquarePlus,
      Sun,
      Trash2,
      TriangleAlert,
      Undo2,
      Ungroup,
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
    autoLayout: async () => {
      await autoArrange();
    },
    labelAttachmentReport: edgeLabelAttachmentReport,
    loadGraph: (document) => {
      openGraphDocument(document, "Debug graph", false);
    },
    waitForRouting: async () => {
      if (!(await initializeLayoutEngine())) throw new Error(routingError ?? "Unable to load the connection router.");
      await ensureAutomaticRouting();
    },
  };
}

edgeLayer.addEventListener("pointerdown", event => {
  const target = (event.target as Element).closest<SVGElement>(".edge-pick");
  const id = target?.dataset.edgeId;
  if (!id) return;
  event.stopPropagation();
  if (target.classList.contains("edge-label-pick")) beginEdgeLabelDrag(event, id);
  else beginEdgeRouteDrag(event, id);
});

must<HTMLButtonElement>("#reroute-graph").addEventListener("click", () => { void rerouteConnections(); });

must<HTMLInputElement>("#node-search").addEventListener("input", renderExplorer);
must<HTMLElement>("#search-results").addEventListener("click", event => {
  const target = (event.target as Element).closest<HTMLButtonElement>("[data-search-node]");
  if (target?.dataset.searchNode) inspectNodes([target.dataset.searchNode], target.dataset.searchNode);
});
must<HTMLButtonElement>("#clear-focus").addEventListener("click", clearFocus);
must<HTMLButtonElement>("[data-clear-focus]").addEventListener("click", clearFocus);
must<HTMLInputElement>("#simulate-toggle").addEventListener("change", event => { simulationActive = (event.target as HTMLInputElement).checked; render(); });
must<HTMLElement>("#simulation-panel").addEventListener("click", event => {
  const target = (event.target as Element).closest<HTMLButtonElement>("button");
  if (target?.dataset.solve) toggleCompleted(target.dataset.solve);
  if (target?.id === "reset-simulation") { completedNodeIds.clear(); render(); }
});
pacingBoard.addEventListener("pointerover", event => {
  const target = (event.target as Element).closest<HTMLButtonElement>(".pacing-bar");
  if (target?.dataset.nodeId && !target.dataset.hasSafeCount) {
    target.title += ` Safe facts: ${getAncestors(target.dataset.nodeId).length}.`;
    target.dataset.hasSafeCount = "true";
  }
});
pacingBoard.addEventListener("focusin", event => {
  const target = (event.target as Element).closest<HTMLButtonElement>(".pacing-bar");
  if (target?.dataset.nodeId && !target.dataset.hasSafeCount) {
    target.title += ` Safe facts: ${getAncestors(target.dataset.nodeId).length}.`;
    target.dataset.hasSafeCount = "true";
  }
});

must<HTMLButtonElement>("#recover-draft").addEventListener("click", openRecoveryDraft);

window.addEventListener("beforeunload", (event) => {
  if (!hasUnsavedChanges() || nativeCloseApproved) return;
  persistRecovery();
  if (!isTauriRuntime()) { event.preventDefault(); event.returnValue = ""; }
});
async function handleNativeCloseRequest(event: { preventDefault: () => void }) {
  // Tauri awaits this handler and destroys the window unless it is cancelled.
  // Requesting close again here re-enters this same event path.
  if (closeDecisionPending) { event.preventDefault(); return; }
  if (!hasUnsavedChanges()) { nativeCloseApproved = true; return; }
  closeDecisionPending = true;
  try {
    if (!(await confirmLeaveGraph())) {
      nativeCloseApproved = false;
      event.preventDefault();
      return;
    }
    nativeCloseApproved = true;
    clearRecovery();
  } catch (error) {
    nativeCloseApproved = false;
    event.preventDefault();
    window.alert(error instanceof Error ? error.message : "Unable to close the graph safely.");
  } finally { closeDecisionPending = false; }
}

if (isTauriRuntime()) {
  void getCurrentWindow().onCloseRequested(handleNativeCloseRequest);
}

render();
installDebugApi();

export { openGraphDocument, analyzeGraph, criticalPathForAnalysis, createGraphDocument, saveGraph, renderGraphToCanvas, handleNativeCloseRequest, ensureAutomaticRouting };
