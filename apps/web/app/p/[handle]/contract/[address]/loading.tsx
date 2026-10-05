// The tab content while its page loads. A `loading.tsx` is a Suspense boundary
// that sits *inside* this segment's layout (layout > error > loading > page), so
// the header and tab bar above are already on screen and this only stands in for
// what changes per tab. It cannot stand in for the layout itself: a boundary
// above the layout would flush the response before the layout's `notFound()` ran
// and turn every unattributed contract into a soft 404 (200 + noindex), the
// trap noted in `app/(dashboard)/app/loading.tsx`. The header's own skeleton is
// a Suspense fallback in the layout, after that check.
const BAR = 'block bg-[#1f1d19] motion-safe:animate-pulse';

export default function Loading() {
  return (
    <div aria-busy="true" data-testid="contract-content-skeleton">
      <span role="status" className="sr-only">
        Loading
      </span>
      <div aria-hidden="true">
        <span className={`${BAR} h-5 w-40`} />
        <span className={`${BAR} mt-8 h-4 w-full max-w-2xl`} />
        <span className={`${BAR} mt-3 h-4 w-full max-w-xl`} />
        <span className={`${BAR} mt-3 h-4 w-2/3 max-w-lg`} />
        <span className={`${BAR} mt-10 h-5 w-32`} />
        <span className={`${BAR} mt-6 h-14 w-full max-w-2xl`} />
        <span className={`${BAR} mt-3 h-14 w-full max-w-2xl`} />
      </div>
    </div>
  );
}
