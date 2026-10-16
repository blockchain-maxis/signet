import { ContractDiagram, loadSlotProps } from '../_slots';

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
        <a
          href={`/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}/diagram.svg?theme=auto`}
          className="mb-6 inline-block text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
          download
        >
          Download SVG
        </a>
      )}
      <ContractDiagram {...props} />
    </>
  );
}
