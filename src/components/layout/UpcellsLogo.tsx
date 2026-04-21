/**
 * Upcells brand mark — a rounded-corner cell with a subtle sync-flow accent.
 * Inherits `currentColor` so it takes on the primary colour of its container.
 */
export default function UpcellsLogo({
  className,
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Outer cell — rounded square */}
      <rect
        x="3"
        y="3"
        width="26"
        height="26"
        rx="6"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      {/* Horizontal divider — suggests a spreadsheet row */}
      <line
        x1="3"
        y1="12"
        x2="29"
        y2="12"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* Vertical divider — suggests a spreadsheet column */}
      <line
        x1="12"
        y1="12"
        x2="12"
        y2="29"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* Accent dot in the top-right quadrant — highlights the active "cell" */}
      <circle cx="21" cy="7.5" r="2" fill="currentColor" />
    </svg>
  );
}
