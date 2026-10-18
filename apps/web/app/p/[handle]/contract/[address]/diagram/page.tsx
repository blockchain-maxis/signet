import { ContractDiagram, loadSlotProps } from '../_slots';
import { ExportPngButton } from './export-png-button';

/** Diagram tab (#445): mounts the `ContractDiagram` slot (#450). */
export default async function DiagramPage({
  params,
}: {
  params: Promise<{ handle: string; address: string }>;
}) {
  const { handle, address } = await params;
  const props = await loadSlotProps(handle, address);
  if (!props) return null;
  return (
    <>
      {props.spec.kind === 'spec' && (
        <div className="mb-6 flex flex-wrap items-center gap-6">
          <a
            href={`/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}/diagram.svg?theme=auto`}
            className="inline-block text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
            download
          >
            Download SVG
          </a>
          <ExportPngButton handle={handle} address={address} />
        </div>
      )}
      <ContractDiagram {...props} />
    </>
  );
}
