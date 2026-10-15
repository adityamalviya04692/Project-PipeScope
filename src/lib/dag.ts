import { Graph, layout } from '@dagrejs/dagre';

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

/** Layered (Sugiyama) layout via dagre; returns top-left positions for React Flow. */
export function layoutDag(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: { rankdir?: 'LR' | 'TB'; nodesep?: number; ranksep?: number } = {},
): Map<string, { x: number; y: number }> {
  const g = new Graph();
  g.setGraph({ rankdir: opts.rankdir ?? 'LR', nodesep: opts.nodesep ?? 28, ranksep: opts.ranksep ?? 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id) as { x: number; y: number } | undefined;
    if (p) out.set(n.id, { x: p.x - n.width / 2, y: p.y - n.height / 2 });
  }
  return out;
}
