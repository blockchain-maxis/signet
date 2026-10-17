import React from 'react';

/**
 * An anchor link icon displayed on heading hover or focus (#473).
 */
export function HeadingAnchor({
  id,
  title,
  className,
}: {
  id: string;
  title: string;
  className?: string;
}) {
  return (
    <a
      href={`#${id}`}
      data-heading-anchor={id}
      aria-label={`Link to ${title}`}
      className={`opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 ml-2.5 inline-flex items-center text-[#8a8779] hover:text-[#e05a4b] transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#e05a4b] ${className ?? ''}`}
    >
      <span aria-hidden="true" className="inline-block text-[#8a8779] hover:text-[#e05a4b]">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </span>
    </a>
  );
}
