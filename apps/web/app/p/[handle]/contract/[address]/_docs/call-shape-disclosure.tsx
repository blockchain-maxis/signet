import React from 'react';
import type { JSONSchema7 } from '@signet/spec';
import {
  EXAMPLE_INVOCATION_CAPTION,
  renderCliSnippet,
  renderTypeScriptSnippet,
} from '@/lib/docs/example-invocation';
import { CopyAddress } from '../../../copy-address';

const MONO = { fontFamily: 'var(--font-mono)' } as const;

export interface CallShapeDisclosureProps {
  fnName: string;
  schema?: JSONSchema7;
  address?: string;
  network?: string;
  className?: string;
}

/**
 * Call shape disclosure (#476, D-13):
 * Renders CLI and TypeScript invocation examples generated from the function's JSON Schema.
 * Includes the required verbatim caption.
 */
export function CallShapeDisclosure({
  fnName,
  schema,
  address,
  network,
  className,
}: CallShapeDisclosureProps) {
  if (!schema) return null;

  const cliSnippet = renderCliSnippet({
    fnName,
    schema,
    address,
    network,
  });

  const tsSnippet = renderTypeScriptSnippet({
    fnName,
    schema,
    contractId: address,
  });

  return (
    <details
      className={`mt-4 border-b border-[#1f1d19] ${className ?? ''}`}
      data-testid="call-shape-disclosure"
    >
      <summary
        className="cursor-pointer select-none py-3 text-[10px] uppercase tracking-[0.22em] text-[#b8b5a8] transition-colors hover:text-[#f5f4ee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#e05a4b]"
        style={MONO}
      >
        Call shape
      </summary>
      <div className="pb-4 space-y-4">
        <div>
          <p
            className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779] mb-2"
            style={MONO}
          >
            Stellar CLI
          </p>
          <pre
            className="overflow-x-auto border border-[#1f1d19] bg-[#12100d] p-4 text-[12px] leading-[1.8] text-[#f5f4ee]"
            tabIndex={0}
            style={MONO}
          >
            <code>{cliSnippet}</code>
          </pre>
          <div className="mt-2">
            <CopyAddress
              address={cliSnippet}
              display="Copy CLI command"
              label="CLI invocation"
              copiedLabel="CLI command copied"
            />
          </div>
        </div>

        <div>
          <p
            className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779] mb-2"
            style={MONO}
          >
            TypeScript SDK
          </p>
          <pre
            className="overflow-x-auto border border-[#1f1d19] bg-[#12100d] p-4 text-[12px] leading-[1.8] text-[#f5f4ee]"
            tabIndex={0}
            style={MONO}
          >
            <code>{tsSnippet}</code>
          </pre>
          <div className="mt-2">
            <CopyAddress
              address={tsSnippet}
              display="Copy TypeScript snippet"
              label="TypeScript snippet"
              copiedLabel="TypeScript snippet copied"
            />
          </div>
        </div>

        <p
          className="max-w-[65ch] text-[12px] leading-[1.7] text-[#8a8779]"
          style={MONO}
        >
          {EXAMPLE_INVOCATION_CAPTION}
        </p>
      </div>
    </details>
  );
}
