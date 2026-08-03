// See the note in app/(dashboard)/app/loading.tsx: loading boundaries only
// belong on segments that never call `notFound()`.
export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a0908]">
      <span className="relative flex h-2 w-2" aria-label="Loading">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#8b1a1a] opacity-70" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#8b1a1a]" />
      </span>
    </div>
  );
}
