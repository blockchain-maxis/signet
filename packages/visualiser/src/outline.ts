/**
 * @file Text-equivalent outline of the contract diagram (#499, backlog E-19).
 *
 * Screen-reader text equivalent of the graph:
 * Structure: groups -> functions -> "uses: Pool (argument), Position (return)" -> nested field types.
 * Each item links to its docs anchor via `hrefForNode`.
 *
 * Pure and deterministic: no DOM, no clock, no randomness.
 */

import type { PositionedDiagramModel, PositionedGroup, PositionedNode, PositionedEdge } from './layout.ts';
import type { DiagramModel, DiagramNode, DiagramEdge } from './index.ts';

/** A node in the text-equivalent diagram outline hierarchy. */
export interface OutlineNode {
  /** Node identifier, e.g. 'group:other', 'fn:submit', 'type:Positions'. */
  readonly id: string;
  /** Display label or name, e.g. 'other', 'submit', 'Positions'. */
  readonly name: string;
  /** Synonym for name to fulfill node contracts. */
  readonly label: string;
  /** Kind of item in the outline hierarchy. */
  readonly kind: 'group' | 'function' | 'type';
  /** Node ID in the underlying graph for docs linking. */
  readonly nodeId?: string;
  /** Edge ID this node represents, if reached via an edge. */
  readonly edgeId?: string;
  /** Human-readable relationship role, e.g. 'argument', 'return', 'field'. */
  readonly role?: string;
  /** Optional overlay metadata for phase-2/3 overlays (read/write mark and provenance). */
  readonly overlay?: {
    readonly readWrite?: 'read' | 'write' | 'readWrite';
    readonly provenance?: string;
  };
  /** Child items nested under this outline item. */
  readonly children?: OutlineNode[];
}

interface ResolvedEdge {
  id: string;
  from: string;
  to: string;
  kinds?: readonly string[];
  label?: string;
}

function edgeIdOf(edge: DiagramEdge | PositionedEdge): string {
  if ('id' in edge && typeof edge.id === 'string') return edge.id;
  return `${edge.from}->${edge.to}`;
}

function nameOfNode(node: PositionedNode | DiagramNode | undefined, fallbackId: string): string {
  if (node && 'name' in node && typeof node.name === 'string') return node.name;
  if (fallbackId.startsWith('fn:')) return fallbackId.slice(3);
  if (fallbackId.startsWith('type:')) return fallbackId.slice(5);
  if (fallbackId.startsWith('group:')) return fallbackId.slice(6);
  return fallbackId;
}

/** Formats edge role kinds ('arg' -> 'argument', 'return' -> 'return', 'field' -> 'field'). */
function formatRole(kinds?: readonly string[], fallback?: string): string {
  if (kinds && kinds.length > 0) {
    const mapped = kinds.map((k) => {
      if (k === 'arg') return 'argument';
      if (k === 'return') return 'return';
      if (k === 'field') return 'field';
      return k;
    });
    return mapped.join(', ');
  }
  if (fallback) {
    if (fallback === 'arg') return 'argument';
    if (fallback === 'return') return 'return';
    if (fallback === 'field') return 'field';
    return fallback;
  }
  return 'reference';
}

/**
 * Traverses an outline tree and collects all represented edge IDs.
 */
export function collectOutlineEdgeIds(outline: readonly OutlineNode[]): string[] {
  const edgeIds: string[] = [];
  function walk(nodes: readonly OutlineNode[]) {
    for (const node of nodes) {
      if (node.edgeId) edgeIds.push(node.edgeId);
      if (node.children) walk(node.children);
    }
  }
  walk(outline);
  return edgeIds;
}

/**
 * Builds a text-equivalent outline of the contract diagram model.
 *
 * Structure: groups -> functions -> "uses: Pool (argument), Position (return)" -> nested field types.
 * Guarantees that every edge in the graph appears exactly once in the outline.
 */
export function buildDiagramOutline(model: PositionedDiagramModel | DiagramModel): OutlineNode[] {
  const nodesById = new Map<string, PositionedNode | DiagramNode>();
  for (const node of model.nodes) {
    nodesById.set(node.id, node);
  }

  // Index outgoing edges by source node id
  const outgoingEdges = new Map<string, ResolvedEdge[]>();
  for (const edge of model.edges) {
    const id = edgeIdOf(edge);
    const kinds = 'kinds' in edge && Array.isArray(edge.kinds) ? (edge.kinds as readonly string[]) : undefined;
    const resolved: ResolvedEdge = {
      id,
      from: edge.from,
      to: edge.to,
      kinds,
      label: edge.label,
    };
    const list = outgoingEdges.get(edge.from);
    if (list) {
      list.push(resolved);
    } else {
      outgoingEdges.set(edge.from, [resolved]);
    }
  }

  const visitedEdgeIds = new Set<string>();

  function expandNestedTypes(sourceId: string, parentOutline: OutlineNode): void {
    const childEdges = outgoingEdges.get(sourceId) ?? [];
    for (const childEdge of childEdges) {
      if (visitedEdgeIds.has(childEdge.id)) continue;
      visitedEdgeIds.add(childEdge.id);

      const targetNode = nodesById.get(childEdge.to);
      const targetName = nameOfNode(targetNode, childEdge.to);

      const nestedOutline: OutlineNode = {
        id: childEdge.to,
        name: targetName,
        label: targetName,
        kind: 'type',
        nodeId: childEdge.to,
        edgeId: childEdge.id,
        role: formatRole(childEdge.kinds, childEdge.label ?? 'field'),
        children: [],
      };
      expandNestedTypes(childEdge.to, nestedOutline);
      parentOutline.children!.push(nestedOutline);
    }
  }

  const outline: OutlineNode[] = [];

  // 1. Process function groups
  const modelGroups: PositionedGroup[] | null =
    'groups' in model && Array.isArray(model.groups) && model.groups.length > 0
      ? model.groups
      : null;

  const functionNodes = model.nodes.filter(
    (n) => n.id.startsWith('fn:') || ('kind' in n && n.kind === 'function'),
  );

  if (modelGroups) {
    const handledFnIds = new Set<string>();
    for (const group of modelGroups) {
      const groupOutline: OutlineNode = {
        id: group.id,
        name: group.name,
        label: group.name,
        kind: 'group',
        children: [],
      };

      for (const fnId of group.nodeIds) {
        handledFnIds.add(fnId);
        const fnNode = nodesById.get(fnId);
        const fnName = nameOfNode(fnNode, fnId);

        const fnOutline: OutlineNode = {
          id: fnId,
          name: fnName,
          label: fnName,
          kind: 'function',
          nodeId: fnId,
          children: [],
        };

        const edgesFromFn = outgoingEdges.get(fnId) ?? [];
        for (const edge of edgesFromFn) {
          visitedEdgeIds.add(edge.id);
          const targetNode = nodesById.get(edge.to);
          const targetName = nameOfNode(targetNode, edge.to);

          const typeOutline: OutlineNode = {
            id: edge.to,
            name: targetName,
            label: targetName,
            kind: 'type',
            nodeId: edge.to,
            edgeId: edge.id,
            role: formatRole(edge.kinds, edge.label),
            children: [],
          };
          expandNestedTypes(edge.to, typeOutline);
          fnOutline.children!.push(typeOutline);
        }
        groupOutline.children!.push(fnOutline);
      }
      outline.push(groupOutline);
    }

    // Ungrouped functions if any
    const remainingFns = functionNodes.filter((fn) => !handledFnIds.has(fn.id));
    if (remainingFns.length > 0) {
      const otherGroup: OutlineNode = {
        id: 'group:other',
        name: 'other',
        label: 'other',
        kind: 'group',
        children: [],
      };
      for (const fnNode of remainingFns) {
        const fnName = nameOfNode(fnNode, fnNode.id);
        const fnOutline: OutlineNode = {
          id: fnNode.id,
          name: fnName,
          label: fnName,
          kind: 'function',
          nodeId: fnNode.id,
          children: [],
        };
        const edgesFromFn = outgoingEdges.get(fnNode.id) ?? [];
        for (const edge of edgesFromFn) {
          visitedEdgeIds.add(edge.id);
          const targetNode = nodesById.get(edge.to);
          const targetName = nameOfNode(targetNode, edge.to);

          const typeOutline: OutlineNode = {
            id: edge.to,
            name: targetName,
            label: targetName,
            kind: 'type',
            nodeId: edge.to,
            edgeId: edge.id,
            role: formatRole(edge.kinds, edge.label),
            children: [],
          };
          expandNestedTypes(edge.to, typeOutline);
          fnOutline.children!.push(typeOutline);
        }
        otherGroup.children!.push(fnOutline);
      }
      outline.push(otherGroup);
    }
  } else if (functionNodes.length > 0) {
    const defaultGroup: OutlineNode = {
      id: 'group:functions',
      name: 'functions',
      label: 'functions',
      kind: 'group',
      children: [],
    };
    for (const fnNode of functionNodes) {
      const fnName = nameOfNode(fnNode, fnNode.id);
      const fnOutline: OutlineNode = {
        id: fnNode.id,
        name: fnName,
        label: fnName,
        kind: 'function',
        nodeId: fnNode.id,
        children: [],
      };
      const edgesFromFn = outgoingEdges.get(fnNode.id) ?? [];
      for (const edge of edgesFromFn) {
        visitedEdgeIds.add(edge.id);
        const targetNode = nodesById.get(edge.to);
        const targetName = nameOfNode(targetNode, edge.to);

        const typeOutline: OutlineNode = {
          id: edge.to,
          name: targetName,
          label: targetName,
          kind: 'type',
          nodeId: edge.to,
          edgeId: edge.id,
          role: formatRole(edge.kinds, edge.label),
          children: [],
        };
        expandNestedTypes(edge.to, typeOutline);
        fnOutline.children!.push(typeOutline);
      }
      defaultGroup.children!.push(fnOutline);
    }
    outline.push(defaultGroup);
  }

  // 2. Process remaining unvisited edges (e.g. types not in function signatures)
  const remainingEdges = model.edges.filter((e) => !visitedEdgeIds.has(edgeIdOf(e)));
  if (remainingEdges.length > 0) {
    const typesGroup: OutlineNode = {
      id: 'group:types',
      name: 'types',
      label: 'types',
      kind: 'group',
      children: [],
    };

    const uniqueSources = Array.from(new Set(remainingEdges.map((e) => e.from)));
    for (const srcId of uniqueSources) {
      const srcNode = nodesById.get(srcId);
      const srcName = nameOfNode(srcNode, srcId);

      const srcOutline: OutlineNode = {
        id: srcId,
        name: srcName,
        label: srcName,
        kind: 'type',
        nodeId: srcId,
        children: [],
      };

      const edgesFromSrc = outgoingEdges.get(srcId) ?? [];
      for (const edge of edgesFromSrc) {
        if (visitedEdgeIds.has(edge.id)) continue;
        visitedEdgeIds.add(edge.id);

        const targetNode = nodesById.get(edge.to);
        const targetName = nameOfNode(targetNode, edge.to);

        const childOutline: OutlineNode = {
          id: edge.to,
          name: targetName,
          label: targetName,
          kind: 'type',
          nodeId: edge.to,
          edgeId: edge.id,
          role: formatRole(edge.kinds, edge.label ?? 'field'),
          children: [],
        };
        expandNestedTypes(edge.to, childOutline);
        srcOutline.children!.push(childOutline);
      }
      typesGroup.children!.push(srcOutline);
    }
    outline.push(typesGroup);
  }

  return outline;
}

/** Escapes special characters for safe HTML inclusion. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders an outline tree into accessible HTML nested lists.
 *
 * Each item is linked to its docs anchor via `hrefForNode`.
 */
export function renderOutlineHtml(
  outline: readonly OutlineNode[],
  hrefForNode: (nodeId: string) => string | null,
): string {
  function renderLink(nodeId: string | undefined, name: string): string {
    const href = nodeId ? hrefForNode(nodeId) : null;
    if (href) {
      return `<a href="${escapeHtml(href)}">${escapeHtml(name)}</a>`;
    }
    return `<span>${escapeHtml(name)}</span>`;
  }

  function renderNestedList(items: readonly OutlineNode[]): string {
    if (items.length === 0) return '';
    const rendered = items.map((t) => {
      const link = renderLink(t.nodeId ?? t.id, t.name);
      const roleStr = t.role ? ` (${escapeHtml(t.role)})` : '';
      const nested = t.children && t.children.length > 0 ? renderNestedList(t.children) : '';
      return `<li>${link}${roleStr}${nested}</li>`;
    });
    return `<ul>${rendered.join('')}</ul>`;
  }

  function renderFunction(fn: OutlineNode): string {
    const link = renderLink(fn.nodeId ?? fn.id, fn.name);
    const overlayText = fn.overlay?.readWrite ? ` [${escapeHtml(fn.overlay.readWrite)}]` : '';
    const provenanceText = fn.overlay?.provenance ? ` (${escapeHtml(fn.overlay.provenance)})` : '';
    const overlayHtml =
      overlayText || provenanceText
        ? `<span class="outline-overlay">${overlayText}${provenanceText}</span>`
        : '';

    if (!fn.children || fn.children.length === 0) {
      return `<li>${link}${overlayHtml}</li>`;
    }

    const hasDeepNesting = fn.children.some((t) => t.children && t.children.length > 0);

    if (!hasDeepNesting) {
      const formattedUses = fn.children
        .map((t) => {
          const tLink = renderLink(t.nodeId ?? t.id, t.name);
          const tRole = t.role ? ` (${escapeHtml(t.role)})` : '';
          return `${tLink}${tRole}`;
        })
        .join(', ');
      return `<li>${link}${overlayHtml}: uses ${formattedUses}</li>`;
    }

    const formattedUses = fn.children
      .map((t) => {
        const tLink = renderLink(t.nodeId ?? t.id, t.name);
        const tRole = t.role ? ` (${escapeHtml(t.role)})` : '';
        const nested = t.children && t.children.length > 0 ? renderNestedList(t.children) : '';
        return `<li>${tLink}${tRole}${nested}</li>`;
      })
      .join('');
    return `<li>${link}${overlayHtml}: uses<ul>${formattedUses}</ul></li>`;
  }

  function renderTypeItem(item: OutlineNode): string {
    const link = renderLink(item.nodeId ?? item.id, item.name);
    if (!item.children || item.children.length === 0) {
      return `<li>${link}</li>`;
    }

    const hasDeepNesting = item.children.some((t) => t.children && t.children.length > 0);
    if (!hasDeepNesting) {
      const formattedFields = item.children
        .map((t) => {
          const tLink = renderLink(t.nodeId ?? t.id, t.name);
          const tRole = t.role ? ` (${escapeHtml(t.role)})` : '';
          return `${tLink}${tRole}`;
        })
        .join(', ');
      return `<li>${link}: contains ${formattedFields}</li>`;
    }

    const formattedFields = item.children
      .map((t) => {
        const tLink = renderLink(t.nodeId ?? t.id, t.name);
        const tRole = t.role ? ` (${escapeHtml(t.role)})` : '';
        const nested = t.children && t.children.length > 0 ? renderNestedList(t.children) : '';
        return `<li>${tLink}${tRole}${nested}</li>`;
      })
      .join('');
    return `<li>${link}: contains<ul>${formattedFields}</ul></li>`;
  }

  const groupItems = outline.map((group) => {
    const groupTitle = `<span class="outline-group-name">${escapeHtml(group.name)}</span>`;
    const childrenHtml = (group.children ?? [])
      .map((child) => {
        if (child.kind === 'function') {
          return renderFunction(child);
        }
        return renderTypeItem(child);
      })
      .join('');
    return `<li>${groupTitle}<ul>${childrenHtml}</ul></li>`;
  });

  return `<ul class="diagram-outline">${groupItems.join('')}</ul>`;
}
