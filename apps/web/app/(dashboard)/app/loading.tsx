// Scoped to the dashboard rather than the app root on purpose. A `loading.tsx`
// wraps its segment in a Suspense boundary, which flushes the response shell
// before the page finishes — and once headers are sent, `notFound()` can no
// longer set a 404. At the root that turned every unclaimed `/p/{handle}` into
// a soft 404 (200 + `robots: noindex`). Keep loading boundaries on segments
// that never call `notFound()`.
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
