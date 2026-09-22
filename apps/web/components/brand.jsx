import { cn } from '@/lib/cn';

export function Logo({ className, size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={cn('shrink-0', className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="url(#nexus-g)" />
      <path
        d="M10 22V10l12 12V10"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient id="nexus-g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366F1" />
          <stop offset="1" stopColor="#4338CA" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Wordmark({ className, size = 28 }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Logo size={size} />
      <span className="text-[17px] font-semibold tracking-[-0.02em]">Nexus</span>
    </span>
  );
}
