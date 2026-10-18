import type { SpecJson } from '@signet/spec';
import { typesTabHref } from '@/lib/docs/function-reference';
import { buildFunctionsToc } from '@/lib/docs/toc';
import { SectionLabel } from '../../../_components/section-label';
import {
  FunctionList,
  TableOfContentsDetails,
  TableOfContentsSticky,
} from '../_docs';
import { DocsState } from '../_docs/docs-state';
import { SpecWarnings } from '../_docs/spec-warnings';
import type { ContractSlotProps } from './slot-props';

/**
 * Functions slot (#450, #466, #473): the function reference with in-page TOC.
 * The h2 is the tab's heading. When the interface could not be read, `DocsState`
 * says why (#470, §1.5) and shows no list; the decoder's warnings sit below the list.
 */
export function ContractFunctions({ handle, address, network, spec }: ContractSlotProps) {
  if (spec.kind === 'failure') {
    return <DocsState slot="functions" failure={spec.failure} network={network} address={address} />;
  }
  const specJson = spec.spec as SpecJson;
  const typesHref = typesTabHref(handle, address);
  const tocItems = buildFunctionsToc(specJson, typesHref);

  return (
    <section data-testid="slot-functions">
      <SectionLabel as="h2">Functions</SectionLabel>
      <div className="mt-6">
        <TableOfContentsDetails items={tocItems} className="lg:hidden" />
        <div className="lg:flex lg:gap-12 lg:items-start">
          <div className="min-w-0 flex-1">
            <FunctionList spec={specJson} handle={handle} address={address} />
          </div>
          <TableOfContentsSticky items={tocItems} />
        </div>
      </div>
      <SpecWarnings warnings={spec.spec.warnings} />
    </section>
  );
}
