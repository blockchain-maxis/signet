import type { SpecJson } from '@signet/spec';
import { typesTabHref } from '@/lib/docs/function-reference';
import { buildTypesToc } from '@/lib/docs/toc';
import { SectionLabel } from '../../../_components/section-label';
import {
  ErrorList,
  TypeList,
  TableOfContentsDetails,
  TableOfContentsSticky,
} from '../_docs';
import { DocsState } from '../_docs/docs-state';
import { SpecWarnings } from '../_docs/spec-warnings';
import type { ContractSlotProps } from './slot-props';

/**
 * Types slot (#450, #467, #468, #473): the types a function can reach, then the
 * contract's errors as a sibling block below, with in-page table of contents.
 */
export function ContractTypes(props: ContractSlotProps) {
  if (props.spec.kind === 'failure') {
    return (
      <DocsState
        slot="types"
        failure={props.spec.failure}
        network={props.network}
        address={props.address}
      />
    );
  }
  // The loader's spec is a full `SpecJson`; `SpecInput` types only the slice the Overview reads.
  const spec = props.spec.spec as SpecJson;
  const typesHref = typesTabHref(props.handle, props.address);
  const tocItems = buildTypesToc(spec, typesHref);

  return (
    <section data-testid="slot-types">
      <SectionLabel as="h2">Types</SectionLabel>
      <div className="mt-6">
        <TableOfContentsDetails items={tocItems} className="lg:hidden" />
        <div className="lg:flex lg:gap-12 lg:items-start">
          <div className="min-w-0 flex-1">
            <TypeList spec={spec} handle={props.handle} address={props.address} />
            <ErrorList spec={spec} handle={props.handle} address={props.address} className="mt-12" />
          </div>
          <TableOfContentsSticky items={tocItems} />
        </div>
      </div>
      <SpecWarnings warnings={props.spec.spec.warnings} />
    </section>
  );
}
