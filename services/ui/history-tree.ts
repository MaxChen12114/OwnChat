/**
 * History tree layout: Branch lanes and a deterministic SVG, no DOM.
 *
 * Adapted from Ephemeral-AI-Lab/dsh-layerfs (MIT):
 *   packages/view/src/tree.js
 *
 * The original draws a LayerFS project's History: main is the middle bough,
 * each Branch a bough in its own colour, each Commit a leaf, forks sprout and
 * merges graft back. Branch lanes are chosen nearest the parent and kept, so
 * the picture does not reshuffle as the run grows. This module keeps the lane
 * rule and the node shapes, drops the zoom/overview/DSH model, and takes a
 * small graph instead:
 *
 *   { nodes: { id: { id, kind, branch, t, parents } },
 *     branches: { name: { name, base, head } },
 *     order: [branchName], mainHead }
 *
 * `t` is an event index, not wall clock: one step per distinct value, so a
 * quiet minute takes no room. `main` is implicit; nodes with branch "main"
 * (or no branch) live on it.
 * @module services/ui/history-tree
 */

export const LEAF = "M0 0Q7 -7.5 15 0Q7 7.5 0 0Z";
const PALETTE = ["#2f5bb5", "#b5682f", "#2f8f5b", "#8b4fb5", "#b52f5b", "#5b8fb5", "#8f8f2f"];

export interface TreeNode {
  id: string;
  kind?: string;
  branch?: string;
  t?: number;
  parents?: Array<string | null>;
}

export interface BranchRecord {
  name?: string;
  base?: string | null;
  head?: string | null;
  from?: string | null;
}

export interface HistoryGraph {
  nodes: Record<string, TreeNode>;
  branches: Record<string, BranchRecord>;
  order?: string[];
  mainHead?: string | null;
}

export interface LaneResult {
  laneOf: Record<string, number>;
  slots: number[];
  rank: Map<number, number>;
  up: number;
  down: number;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
}

export interface Position {
  x: number;
  y: number;
  branch: string;
  node: TreeNode;
}

export interface LayoutResult {
  svg: string;
  lanes: Record<string, number>;
  rows: Record<string, number>;
  positions: Record<string, Position>;
  colors: Record<string, string>;
  width: number;
  height: number;
}

export interface WorkspaceRun {
  id: string;
  ts: number;
}

export interface WorkspaceVersion {
  seq: number | string;
  ts: number;
  kind?: string;
  from?: number | string;
}

export interface WorkspaceFile {
  path: string;
  versions: WorkspaceVersion[];
}

export interface WorkspaceInput {
  runs: WorkspaceRun[];
  files: WorkspaceFile[];
}

export function branchColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

function esc(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function strOf(value: unknown): string {
  return value == null ? "" : String(value);
}

function numOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function branchOf(node: TreeNode | undefined): string {
  return node ? strOf(node.branch) || "main" : "main";
}

function rankOf(node: TreeNode | null | undefined, rank: Map<number, number>): number {
  if (!node) return 0;
  return rank.get(numOf(node.t)) || 0;
}

/**
 * Choose a lane per Branch: nearest free lane to its parent, same side, and
 * keep it. A lane is busy while a Branch still has nodes before `until`.
 */
export function assignLanes(graph: HistoryGraph): LaneResult {
  const N = graph.nodes || {};
  const B = graph.branches || {};
  const names = Array.isArray(graph.order) ? graph.order.filter((b) => B[b]) : Object.keys(B);
  const nodes = Object.values(N);
  const slots = [...new Set(nodes.map((n) => numOf(n.t)))].sort((a, b) => a - b);
  const rank = new Map<number, number>(slots.map((t, i) => [t, i] as [number, number]));

  const parentOf = (name: string): string => {
    const base = N[strOf(B[name].base)];
    return base ? branchOf(base) : "main";
  };

  // How long each Branch keeps its lane: through its last node and its tag,
  // and at least to each child's fork.
  const until: Record<string, number> = {};
  for (const name of names) {
    const own = nodes.filter((n) => branchOf(n) === name);
    until[name] = own.reduce((m, n) => Math.max(m, rankOf(n, rank)), 0) + 3;
  }
  for (const name of names) {
    const p = parentOf(name);
    if (p === "main") continue;
    until[p] = Math.max(until[p] || 0, rankOf(N[strOf(B[name].base)], rank) + 1);
  }

  const laneOf: Record<string, number> = { main: 0 };
  const live: Record<string, number> = { "1": 0, "-1": 0 };
  const seen: string[] = [];
  const sorted = names.slice().sort((a, b) =>
    rankOf(N[strOf(B[a].base)], rank) - rankOf(N[strOf(B[b].base)], rank) ||
    names.indexOf(a) - names.indexOf(b));

  for (const name of sorted) {
    const baseRank = rankOf(N[strOf(B[name].base)], rank);
    const busy = new Set(
      seen.filter((x) => until[x] > baseRank).map((x) => laneOf[x]),
    );
    const pl = laneOf[parentOf(name)] ?? 0;
    const side = Math.sign(pl) || (live["1"] <= live["-1"] ? 1 : -1);
    let lane: number | undefined;
    if (pl) {
      for (let k = 1; lane === undefined; k++) {
        const candidates = [pl + side * k, pl - side * k];
        lane = candidates.find((c) => Math.sign(c) === side && !busy.has(c));
      }
    } else {
      for (let d = 1; lane === undefined; d++) {
        lane = !busy.has(side * d) ? side * d : !busy.has(-side * d) ? -side * d : undefined;
      }
    }
    laneOf[name] = lane === undefined ? 0 : lane;
    seen.push(name);
    if (until[name] > baseRank) live[String(Math.sign(laneOf[name]))]++;
  }

  const lanes = names.map((n) => laneOf[n]);
  return {
    laneOf,
    slots,
    rank,
    up: Math.max(0, ...lanes),
    down: Math.max(0, ...lanes.map((l) => -l)),
  };
}

/**
 * Layout and draw. Output is deterministic for the same graph and size, so a
 * test can pin both the geometry and the picture.
 */
export function layoutTree(graph: HistoryGraph, opts: LayoutOptions = {}): LayoutResult {
  const N = graph.nodes || {};
  const B = graph.branches || {};
  const width = numOf(opts.width) || 900;
  const height = numOf(opts.height) || 360;
  const names = Array.isArray(graph.order) ? graph.order.filter((b) => B[b]) : Object.keys(B);
  const mainHead = graph.mainHead || null;
  const lanes = assignLanes({ nodes: N, branches: B, order: names, mainHead });

  const margin = { left: 80, right: 150, top: 48, bottom: 48 };
  const laneGap = Math.max(34, Math.min(52, (height - margin.top - margin.bottom) / Math.max(2, lanes.up + lanes.down + 1)));
  const center = margin.top + (lanes.up + 0.5) * laneGap;
  const stepX = Math.max(28, Math.min(64, (width - margin.left - margin.right) / Math.max(1, lanes.slots.length - 1)));
  const mainY = center;
  const rowOf: Record<string, number> = { main: 0 };
  for (const name of names) rowOf[name] = -lanes.laneOf[name];

  const positions: Record<string, Position> = {};
  const colors: Record<string, string> = { main: "#5b8f5b" };
  names.forEach((name, i) => { colors[name] = branchColor(i); });

  const byBranch: Record<string, TreeNode[]> = { main: [] };
  for (const name of names) byBranch[name] = byBranch[name] || [];
  for (const node of Object.values(N)) {
    const b = branchOf(node);
    (byBranch[b] || (byBranch[b] = [])).push(node);
  }
  for (const [branch, list] of Object.entries(byBranch)) {
    list.sort((a, b) => numOf(a.t) - numOf(b.t));
    let prev = -Infinity;
    for (const node of list) {
      const baseX = margin.left + (lanes.rank.get(numOf(node.t)) || 0) * stepX;
      const x = Math.max(baseX, prev + 18);
      const y = mainY + (rowOf[branch] || 0) * laneGap;
      positions[node.id] = { x, y, branch, node };
      prev = x;
    }
  }

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="OwnChat agent history tree">`);
  parts.push(`<style>
    .bg{fill:#0f1115}.lane{stroke:#1d2230;stroke-width:1}
    .edge{fill:none;stroke-width:2;stroke-linecap:round;opacity:.75}
    .far{opacity:.35}.node{cursor:default}
    .leaf{stroke-width:1.2}.fork{stroke-width:1.4;fill:#0f1115}
    .band{fill:#5b8f5b;opacity:.28}
    .label{font:11px/1.2 ui-sans-serif,system-ui;fill:#c9d1e0}
    .axis{font:10px/1.2 ui-sans-serif,system-ui;fill:#6b7488}
  </style>`);
  parts.push(`<rect class="bg" x="0" y="0" width="${width}" height="${height}"/>`);

  for (const [name, lane] of Object.entries(lanes.laneOf)) {
    const y = mainY + (rowOf[name] || 0) * laneGap;
    parts.push(`<line class="lane" x1="${margin.left - 20}" x2="${width - margin.right + 20}" y1="${y}" y2="${y}"/>`);
  }

  const mainNodes = Object.values(N)
    .filter((n) => branchOf(n) === "main")
    .sort((a, b) => numOf(a.t) - numOf(b.t));
  if (mainNodes.length) {
    const xs = mainNodes.map((n) => positions[n.id].x);
    parts.push(`<line x1="${Math.min(...xs)}" x2="${Math.max(...xs)}" y1="${mainY}" y2="${mainY}" stroke="${colors.main}" stroke-width="5" stroke-linecap="round"/>`);
    for (const n of mainNodes) {
      if (n.kind !== "layer") continue;
      const p = positions[n.id];
      parts.push(`<rect class="band" x="${p.x - 4}" y="${mainY - 9}" width="8" height="18" rx="3"/>`);
    }
  }

  for (const node of Object.values(N)) {
    const to = positions[node.id];
    if (!to) continue;
    const parents = Array.isArray(node.parents) ? node.parents : [];
    for (const pid of parents) {
      const from = pid ? positions[pid] : null;
      if (!from) continue;
      const color = colors[branchOf(node)] || colors.main;
      const far = branchOf(node) !== from.branch;
      if (Math.abs(from.y - to.y) < 0.5) {
        parts.push(`<path class="edge${far ? " far" : ""}" d="M${from.x} ${from.y} L${to.x} ${to.y}" style="stroke:${color}"/>`);
      } else {
        const bend = Math.min(28, Math.abs(to.x - from.x) / 2);
        const mx = from.x + bend;
        parts.push(`<path class="edge${far ? " far" : ""}" d="M${from.x} ${from.y} C${mx} ${from.y} ${mx} ${to.y} ${to.x} ${to.y}" style="stroke:${color}"/>`);
      }
    }
  }

  for (const node of Object.values(N)) {
    const p = positions[node.id];
    if (!p) continue;
    const color = colors[p.branch] || colors.main;
    const kind = strOf(node.kind) || "commit";
    if (kind === "fork") {
      parts.push(`<g class="node" data-node="${esc(node.id)}" data-branch="${esc(p.branch)}"><path class="fork" d="M${p.x} ${p.y - 6} L${p.x + 6} ${p.y} L${p.x} ${p.y + 6} L${p.x - 6} ${p.y} Z" style="stroke:${color}"/></g>`);
    } else if (kind === "merge") {
      parts.push(`<g class="node" data-node="${esc(node.id)}" data-branch="${esc(p.branch)}"><circle cx="${p.x}" cy="${p.y}" r="6.5" fill="#0f1115" stroke="${color}" stroke-width="2.2"/><circle cx="${p.x}" cy="${p.y}" r="2.4" fill="${color}"/></g>`);
    } else {
      parts.push(`<g class="node" data-node="${esc(node.id)}" data-branch="${esc(p.branch)}"><path class="leaf" d="${LEAF}" transform="translate(${p.x - 7} ${p.y})" fill="${color}"/></g>`);
    }
  }

  for (const name of names) {
    const head = B[name].head;
    const p = head ? positions[head] : null;
    if (!p) continue;
    const short = name.length > 18 ? name.slice(0, 17) + "…" : name;
    parts.push(`<text class="label" x="${p.x + 12}" y="${p.y + 4}" data-tag="${esc(name)}">${esc(short)}</text>`);
  }
  if (mainHead && positions[mainHead]) {
    const p = positions[mainHead];
    parts.push(`<text class="axis" x="${p.x + 12}" y="${p.y - 12}">main</text>`);
  }
  parts.push("</svg>");

  return {
    svg: parts.join("\n"),
    lanes: lanes.laneOf,
    rows: rowOf,
    positions,
    colors,
    width,
    height,
  };
}

/**
 * OwnChat helper: a conversation's run list becomes main; each file becomes a
 * Branch that forks where it first appears; each version a leaf; a restore is
 * a merge back to the version it restored.
 */
export function buildWorkspaceHistory(input: WorkspaceInput): HistoryGraph {
  const runs = (Array.isArray(input.runs) ? input.runs : [])
    .slice()
    .sort((a, b) => a.ts - b.ts);
  const nodes: Record<string, TreeNode> = {};
  let prev: string | null = null;
  for (const run of runs) {
    nodes[run.id] = { id: run.id, kind: "layer", branch: "main", t: run.ts, parents: [prev] };
    prev = run.id;
  }
  const branches: Record<string, BranchRecord> = {};
  const order: string[] = [];
  for (const file of input.files || []) {
    const versions = (file.versions || []).slice().sort((a, b) => a.ts - b.ts);
    if (!versions.length) continue;
    const base = runs.filter((r) => r.ts <= versions[0].ts).pop() || runs[0];
    if (!base) continue;
    const forkId = "fork:" + file.path;
    nodes[forkId] = { id: forkId, kind: "fork", branch: file.path, t: versions[0].ts, parents: [base.id] };
    let last = forkId;
    for (const v of versions) {
      const id = file.path + "#" + v.seq;
      const kind = v.kind === "restore" ? "merge" : "commit";
      const parents: Array<string | null> = [last];
      if (v.from != null) {
        const fromId = file.path + "#" + v.from;
        if (fromId !== last && nodes[fromId]) parents.push(fromId);
      }
      nodes[id] = { id, kind, branch: file.path, t: v.ts, parents };
      last = id;
    }
    branches[file.path] = { name: file.path, base: base.id, head: last };
    order.push(file.path);
  }
  return { nodes, branches, order, mainHead: prev };
}
