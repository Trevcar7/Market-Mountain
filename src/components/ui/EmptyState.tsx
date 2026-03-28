"use client";

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: "chart" | "briefing" | "search" | "news";
  action?: {
    label: string;
    href: string;
  };
}

function MountainIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Mountain silhouette */}
      <path
        d="M4 44L18 12L26 28L32 16L44 44"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.3"
      />
      {/* Taller peak */}
      <path
        d="M20 44L38 8L56 44"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.5"
      />
      {/* Summit accent */}
      <path
        d="M36 12L38 8L40 12"
        stroke="#22C55E"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Chart line overlay */}
      <path
        d="M8 36L16 32L24 34L32 26L40 28L48 20L56 24"
        stroke="#22C55E"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.6"
      />
    </svg>
  );
}

export default function EmptyState({
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <MountainIcon className="w-20 h-20 text-navy-200 mb-6" />
      <h3 className="text-lg font-semibold text-navy-700 mb-2 font-serif">
        {title}
      </h3>
      <p className="text-sm text-text-muted max-w-sm leading-relaxed mb-6">
        {description}
      </p>
      {action && (
        <a
          href={action.href}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent-500 text-navy-900 font-semibold text-sm rounded-lg hover:bg-accent-600 transition-colors"
        >
          {action.label}
        </a>
      )}
    </div>
  );
}
