import { Provenance } from '../_docs/provenance';
import { ContractFunctions, loadSlotProps } from '../_slots';

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
      <ContractFunctions {...props} />
    </>
  );
}
