import type { LayoutNode } from '../shared/types';

export type Side = 'left' | 'right' | 'top' | 'bottom';

export const leaf = (paneId: string): LayoutNode => ({ type: 'pane', paneId });

/** Visible panes, left to right and top to bottom. */
export function panesIn(node: LayoutNode | null): string[] {
  if (!node) return [];
  return node.type === 'pane' ? [node.paneId] : node.children.flatMap(panesIn);
}

/** Drops a pane; a split left with one child collapses into it and its siblings share the space. */
export function removePane(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'pane') return node.paneId === id ? null : node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const kept = removePane(child, id);
    if (kept) {
      children.push(kept);
      sizes.push(node.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

export function replacePane(node: LayoutNode, id: string, withId: string): LayoutNode {
  if (node.type === 'pane') return node.paneId === id ? leaf(withId) : node;
  return { ...node, children: node.children.map((child) => replacePane(child, id, withId)) };
}

/** Puts `newId` next to `targetId` on the given side, splitting the target's space in half. */
export function splitPane(node: LayoutNode, targetId: string, newId: string, side: Side): LayoutNode {
  const dir = side === 'left' || side === 'right' ? 'row' : 'column';
  const before = side === 'left' || side === 'top';
  const visit = (n: LayoutNode): LayoutNode => {
    if (n.type === 'pane') {
      if (n.paneId !== targetId) return n;
      return { type: 'split', dir, children: before ? [leaf(newId), n] : [n, leaf(newId)], sizes: [0.5, 0.5] };
    }
    // Splitting along the parent's own direction adds a sibling instead of nesting another split.
    const i = n.children.findIndex((c) => c.type === 'pane' && c.paneId === targetId);
    if (i >= 0 && n.dir === dir) {
      const children = [...n.children];
      const sizes = [...n.sizes];
      children.splice(before ? i : i + 1, 0, leaf(newId));
      sizes.splice(i, 1, sizes[i] / 2, sizes[i] / 2);
      return { ...n, children, sizes };
    }
    return { ...n, children: n.children.map(visit) };
  };
  return visit(node);
}
