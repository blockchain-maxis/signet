/**
 * @file Error surface, declared events and build provenance panels (#496, design §2.2).
 *
 * Errors and events "connect to everything or nothing", so they are rendered as
 * lists beneath the diagram spine rather than nodes in the graph. Build provenance
 * from `contractmetav0` (soroban-sdk and rustc versions) provides useful provenance.
 *
 * Structured data extraction is pure and environment-agnostic; `renderPanelsHtml`
 * emits semantic, accessible HTML with zero inline hex colours.
 */

import type { ContractBuild, SpecErrorCase, SpecEvent, TypeRef } from '@signet/spec';

export interface PanelError {
  name: string;
  code: number;
  doc?: string;
  enumName?: string;
}

export interface PanelEvent {
  name: string;
  topics: string[];
  dataType: string;
  doc?: string;
}

export interface PanelBuild {
  sdkVersion?: string;
  rustVersion?: string;
}

export interface DiagramPanels {
  errors: PanelError[];
  events: PanelEvent[];
  build?: PanelBuild;
}

/** Formats a TypeRef into a readable type signature. */
function formatTypeRef(type: TypeRef): string {
  if (typeof type === 'string') {
    return type === 'void' ? '()' : type;
  }
  switch (type.type) {
    case 'named':
      return type.name;
    case 'option':
      return `Option<${formatTypeRef(type.value)}>`;
    case 'vec':
      return `Vec<${formatTypeRef(type.element)}>`;
    case 'map':
      return `Map<${formatTypeRef(type.key)}, ${formatTypeRef(type.value)}>`;
    case 'tuple':
      return `(${type.elements.map(formatTypeRef).join(', ')})`;
    case 'bytes_n':
      return `BytesN<${type.n}>`;
    case 'result':
      return `Result<${formatTypeRef(type.ok)}, ${formatTypeRef(type.error)}>`;
    case 'unknown':
      return type.xdrArm ?? 'unknown';
    default:
      return 'val';
  }
}

/** Formats event payload parameters into a readable data type. */
function formatEventPayload(ev: SpecEvent): string {
  const dataParams = ev.params.filter((p) => p.location === 'data');
  if (dataParams.length === 0) return 'void';
  if (dataParams.length === 1) {
    const first = dataParams[0]!;
    return first.name ? `${first.name}: ${formatTypeRef(first.type)}` : formatTypeRef(first.type);
  }
  return `(${dataParams.map((p) => (p.name ? `${p.name}: ${formatTypeRef(p.type)}` : formatTypeRef(p.type))).join(', ')})`;
}

/** Escapes text for safe inclusion in HTML strings. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Extracts errors, events and build provenance from an abstract ContractGraph (or spec).
 */
export function diagramPanels(
  graph: {
    readonly errors?: readonly SpecErrorCase[];
    readonly events?: readonly SpecEvent[];
    readonly build?: ContractBuild | undefined;
  },
): DiagramPanels {
  const errors: PanelError[] = (graph.errors ?? []).map((err) => ({
    name: err.name,
    code: err.value,
    ...(err.doc ? { doc: err.doc } : {}),
    ...(err.enumName ? { enumName: err.enumName } : {}),
  }));

  const events: PanelEvent[] = (graph.events ?? []).map((ev) => {
    const topicParams = ev.params.filter((p) => p.location === 'topic').map((p) => p.name);
    const topics = [...ev.prefixTopics, ...topicParams];
    return {
      name: ev.name,
      topics,
      dataType: formatEventPayload(ev),
      ...(ev.doc ? { doc: ev.doc } : {}),
    };
  });

  const build: PanelBuild | undefined =
    graph.build && (graph.build.sdkVersion || graph.build.rustVersion)
      ? {
          ...(graph.build.sdkVersion ? { sdkVersion: graph.build.sdkVersion } : {}),
          ...(graph.build.rustVersion ? { rustVersion: graph.build.rustVersion } : {}),
        }
      : undefined;

  return {
    errors,
    events,
    ...(build ? { build } : {}),
  };
}

/**
 * Renders structured diagram panels into an accessible semantic HTML string.
 * Uses <dl> and <ul> lists with no inline hex colours, and states clearly
 * that the spec does not map errors to specific functions.
 */
export function renderPanelsHtml(panels: DiagramPanels): string {
  const parts: string[] = ['<div class="viz-panels">'];

  // 1. Errors section
  parts.push('  <section class="viz-panel viz-panel--errors" aria-labelledby="viz-panel-errors-title">');
  parts.push('    <h3 id="viz-panel-errors-title" class="viz-panel__title">Error surface</h3>');
  parts.push(
    '    <p class="viz-panel__note">Returned by: not declared in the contract interface (the interface defines errors at the contract level).</p>',
  );

  if (panels.errors.length === 0) {
    parts.push('    <p class="viz-panel__empty">No errors declared in the interface.</p>');
  } else {
    parts.push('    <dl class="viz-panel__list viz-panel__list--errors">');
    for (const err of panels.errors) {
      parts.push(
        `      <dt class="viz-error__name"><code>${escapeHtml(err.name)}</code> <span class="viz-error__code">#${err.code}</span></dt>`,
      );
      parts.push('      <dd class="viz-error__detail">');
      if (err.doc) {
        parts.push(`        <p class="viz-error__doc">${escapeHtml(err.doc)}</p>`);
      }
      if (err.enumName) {
        parts.push(`        <span class="viz-error__enum">${escapeHtml(err.enumName)}</span>`);
      }
      parts.push('      </dd>');
    }
    parts.push('    </dl>');
  }
  parts.push('  </section>');

  // 2. Events section
  parts.push('  <section class="viz-panel viz-panel--events" aria-labelledby="viz-panel-events-title">');
  parts.push('    <h3 id="viz-panel-events-title" class="viz-panel__title">Declared events</h3>');

  if (panels.events.length === 0) {
    parts.push('    <p class="viz-panel__empty">No events declared in the interface.</p>');
  } else {
    parts.push('    <ul class="viz-panel__list viz-panel__list--events">');
    for (const ev of panels.events) {
      parts.push('      <li class="viz-event">');
      parts.push(`        <div class="viz-event__header"><code>${escapeHtml(ev.name)}</code></div>`);
      if (ev.doc) {
        parts.push(`        <p class="viz-event__doc">${escapeHtml(ev.doc)}</p>`);
      }
      if (ev.topics.length > 0) {
        parts.push(
          `        <div class="viz-event__topics"><span class="viz-label">Topics:</span> <code>${escapeHtml(ev.topics.join(' · '))}</code></div>`,
        );
      }
      parts.push(
        `        <div class="viz-event__data"><span class="viz-label">Payload:</span> <code>${escapeHtml(ev.dataType)}</code></div>`,
      );
      parts.push('      </li>');
    }
    parts.push('    </ul>');
  }
  parts.push('  </section>');

  // 3. Build provenance section
  if (panels.build && (panels.build.sdkVersion || panels.build.rustVersion)) {
    parts.push('  <section class="viz-panel viz-panel--build" aria-labelledby="viz-panel-build-title">');
    parts.push('    <h3 id="viz-panel-build-title" class="viz-panel__title">Build provenance</h3>');
    parts.push('    <dl class="viz-panel__list viz-panel__list--build">');
    if (panels.build.sdkVersion) {
      parts.push('      <dt>Soroban SDK</dt>');
      parts.push(`      <dd><code>${escapeHtml(panels.build.sdkVersion)}</code></dd>`);
    }
    if (panels.build.rustVersion) {
      parts.push('      <dt>Rustc</dt>');
      parts.push(`      <dd><code>${escapeHtml(panels.build.rustVersion)}</code></dd>`);
    }
    parts.push('    </dl>');
    parts.push('  </section>');
  }

  parts.push('</div>');
  return parts.join('\n');
}
