import { ContractTypes, loadSlotProps } from '../_slots';

/** Types tab (#445): mounts the `ContractTypes` slot (#450). */
export default async function TypesPage({
  params,
}: {
  params: Promise<{ handle: string; address: string }>;
}) {
  const { handle, address } = await params;
  const props = await loadSlotProps(handle, address);
  if (!props) return null;
  return <ContractTypes {...props} />;
}
