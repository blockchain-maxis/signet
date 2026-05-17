// Placeholder public profile ({handle}.signet.dev).
// TODO(signet): fetch the profile by handle; 404 when it doesn't exist.
export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return (
    <div>
      <h1>Signet — profile</h1>
      <p>route: (profile) /profile/{handle}</p>
    </div>
  );
}
