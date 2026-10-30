import Link from 'next/link';

export function Logo({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-2.5">
      <span className="relative grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 shadow-glow">
        <span className="absolute inset-0 rounded-xl bg-brand-400/40 blur-md transition group-hover:bg-brand-300/60" />
        <svg viewBox="0 0 24 24" className="relative h-5 w-5 text-white" fill="none">
          <path
            d="M4 7.5A2.5 2.5 0 0 1 6.5 5h6A2.5 2.5 0 0 1 15 7.5v9A2.5 2.5 0 0 1 12.5 19h-6A2.5 2.5 0 0 1 4 16.5v-9Z"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path
            d="m15.5 10.2 3.4-2.1a.8.8 0 0 1 1.2.7v6.4a.8.8 0 0 1-1.2.7l-3.4-2.1"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="text-[15px] font-bold tracking-tight text-fg">
        Nexa<span className="text-brand-400">Live</span>
      </span>
    </Link>
  );
}
