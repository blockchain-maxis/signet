export function SignetMonogram({ className }: { className?: string }) {
  return (
    <svg viewBox="-12 -12 24 24" className={className} aria-hidden="true">
      <polygon
        points="0,-10 8.7,-5 8.7,5 0,10 -8.7,5 -8.7,-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M -3.6,-4 Q -3.6,-7 0,-7 Q 3.6,-7 3.6,-3.2 Q 3.6,0 0,0 Q -3.6,0 -3.6,3.2 Q -3.6,7 0,7 Q 3.6,7 3.6,4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
