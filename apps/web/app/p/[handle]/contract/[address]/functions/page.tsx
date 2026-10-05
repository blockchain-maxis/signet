import { ContractFunctions, loadSlotProps } from '../_slots';

/** Functions tab (#445): mounts the `ContractFunctions` slot (#450). */
export default async function FunctionsPage({
  params,
}: {
  params: Promise<{ handle: string; address: string }>;
}) {
  const { handle, address } = await params;
  const props = await loadSlotProps(handle, address);
  if (!props) return null;
  return <ContractFunctions {...props} />;
}
