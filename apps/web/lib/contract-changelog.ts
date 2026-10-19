import React from 'react';
import { diffSpecs, type SpecDiff, type SpecChange, type SpecJson } from '@signet/spec';
import { formatDate } from './format-date.ts';
import { truncateMiddle } from './contract-header.ts';

export interface VersionSpecItem {
  readonly wasmHash: string;
  readonly observedAt: Date | string;
  readonly spec?: SpecJson | null;
  readonly unretrievable?: boolean;
}

export interface ContractChangesProps {
  readonly versions: readonly VersionSpecItem[];
  readonly network: string;
}

function formatChangeLabel(change: SpecChange): string {
  const cleanPath = change.path.replace(/^(functions|errors|types)\./, '');
  switch (change.kind) {
    case 'function-added':
      return `Added function ${cleanPath}`;
    case 'function-removed':
      return `Removed function ${cleanPath}`;
    case 'argument-added':
      return `Added argument ${cleanPath}`;
    case 'argument-removed':
      return `Removed argument ${cleanPath}`;
    case 'argument-renamed':
      return `Renamed argument ${cleanPath}`;
    case 'argument-retyped':
      return `Retyped argument ${cleanPath}`;
    case 'return-type-changed':
      return `Changed return type for ${cleanPath}`;
    case 'documentation-changed':
      return `Documentation changed for ${cleanPath}`;
    case 'type-added':
      return `Added type ${cleanPath}`;
    case 'type-removed':
      return `Removed type ${cleanPath}`;
    case 'type-changed':
      return `Changed type ${cleanPath}`;
    case 'field-added':
      return `Added field ${cleanPath}`;
    case 'field-removed':
      return `Removed field ${cleanPath}`;
    case 'field-renamed':
      return `Renamed field ${cleanPath}`;
    case 'field-retyped':
      return `Retyped field ${cleanPath}`;
    case 'case-added':
      return `Added case ${cleanPath}`;
    case 'case-removed':
      return `Removed case ${cleanPath}`;
    case 'variant-added':
      return `Added variant ${cleanPath}`;
    case 'variant-removed':
      return `Removed variant ${cleanPath}`;
    case 'variant-renumbered':
      return `Renumbered variant ${cleanPath}`;
    case 'error-added':
      return `Added error ${cleanPath}`;
    case 'error-removed':
      return `Removed error ${cleanPath}`;
    case 'error-renumbered':
      return `Renumbered error ${cleanPath}`;
    case 'event-changed':
      return `Changed event ${cleanPath}`;
    default:
      return `${change.kind}: ${cleanPath}`;
  }
}

export function ContractChanges({ versions, network }: ContractChangesProps): React.ReactElement | null {
  if (!versions || versions.length <= 1) {
    return null;
  }

  const renderedVersions: React.ReactNode[] = [];

  for (let i = 0; i < versions.length; i++) {
    const current = versions[i]!;
    const shortHash = truncateMiddle(current.wasmHash, 6, 6);
    const dateStr = formatDate(
      typeof current.observedAt === 'string' ? current.observedAt : current.observedAt.toISOString(),
    );
    const headingText = `${shortHash} · observed ${dateStr}`;

    if (current.unretrievable || !current.spec) {
      renderedVersions.push(
        React.createElement(
          'div',
          {
            key: current.wasmHash,
            className: 'border-b border-[#1f1d19] py-4',
            'data-testid': `version-change-${current.wasmHash}`,
          },
          React.createElement('div', { className: 'font-mono text-xs font-semibold text-[#8a8779]' }, headingText),
          React.createElement(
            'p',
            { className: 'mt-2 break-all text-xs text-[#e05a4b]' },
            `Interface for ${current.wasmHash} is no longer retrievable from ${network}`,
          ),
        ),
      );
      continue;
    }

    let prevSpec: SpecJson | null = null;
    for (let j = i + 1; j < versions.length; j++) {
      if (versions[j]?.spec && !versions[j]?.unretrievable) {
        prevSpec = versions[j]!.spec!;
        break;
      }
    }

    let diff: SpecDiff | null = null;
    if (prevSpec) {
      diff = diffSpecs(prevSpec, current.spec);
    }

    const changeNodes: React.ReactNode[] = [];
    if (diff && diff.changes.length > 0) {
      for (let idx = 0; idx < diff.changes.length; idx++) {
        const change = diff.changes[idx]!;
        const items: React.ReactNode[] = [
          React.createElement('span', { key: 'label' }, formatChangeLabel(change)),
        ];
        if (change.breaking) {
          items.push(
            React.createElement(
              'span',
              {
                key: 'breaking',
                className: 'rounded bg-red-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-red-400 border border-red-800/40',
              },
              'breaking',
            ),
          );
        }
        if (change.reason) {
          items.push(
            React.createElement(
              'span',
              { key: 'reason', className: 'text-[#8a8779] text-[11px]' },
              ` (${change.reason})`,
            ),
          );
        }
        changeNodes.push(
          React.createElement('li', { key: idx, className: 'flex flex-wrap items-center gap-2 break-words text-xs text-[#dcd9ce]' }, ...items),
        );
      }
    }

    renderedVersions.push(
      React.createElement(
        'div',
        {
          key: current.wasmHash,
          className: 'border-b border-[#1f1d19] py-4',
          'data-testid': `version-change-${current.wasmHash}`,
        },
        React.createElement('div', { className: 'font-mono text-xs font-semibold text-[#8a8779]' }, headingText),
        changeNodes.length > 0
          ? React.createElement('ul', { className: 'mt-3 space-y-2' }, ...changeNodes)
          : prevSpec
            ? React.createElement('p', { className: 'mt-2 text-xs text-[#8a8779]' }, 'No interface changes detected.')
            : React.createElement('p', { className: 'mt-2 text-xs text-[#8a8779]' }, 'Initial tracked version.'),
      ),
    );
  }

  return React.createElement(
    'section',
    { className: 'mt-12 border-t border-[#1f1d19] pt-8', 'data-testid': 'changes-section' },
    React.createElement('h3', { className: 'text-sm font-semibold uppercase tracking-wider text-[#f5f4ee]' }, 'Changes'),
    React.createElement(
      'p',
      { className: 'mt-1 text-xs text-[#8a8779]' },
      'Dates reflect when Signet’s indexer observed each upgrade, not necessarily the on-chain deployment moment.',
    ),
    React.createElement('div', { className: 'mt-4 divide-y divide-[#1f1d19]' }, ...renderedVersions),
  );
}
