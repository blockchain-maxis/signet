// Placeholder per-contract detail page.
// TODO(signet): render contract metadata + indexed activity for this address.
export default async function ContractPage({
  params,
}: {
  params: Promise<{ handle: string; address: string }>;
}) {
  const { handle, address } = await params;
  return (
    <div>
      <h1>Signet — contract</h1>
      <p>
        route: (profile) /profile/{handle}/contract/{address}
      </p>
    </div>
  );
}
