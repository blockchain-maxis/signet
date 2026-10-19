import { Provenance } from '../_docs/provenance';
import { ContractFunctions, loadSlotProps } from '../_slots';
import { loadVersionSpecs } from '../_slots/load-version-specs';

/**
 * Functions tab (#445): the provenance strip (#471) above the
 * `ContractFunctions` slot (#450).
 */
export default async function FunctionsPage({
  params,
}: {
  params: Promise<{ handle: string; address: string }>;
}) {
  const { handle, address } = await params;
  const props = await loadSlotProps(handle, address);
  if (!props) return null;
  const versionSpecs = await loadVersionSpecs(props);
  return (
    <>
      <div className="mb-10">
        <Provenance
          address={props.address}
          network={props.network}
          spec={props.spec}
          wasmHash={props.wasmHash}
        />
      </div>
      <ContractFunctions {...props} versionSpecs={versionSpecs} />
    </>
  );
}
