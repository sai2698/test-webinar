import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { ConsoleLink } from '@/components/ConsoleLink';

const DELAYS = ['animate-delay-100', 'animate-delay-200', 'animate-delay-300', 'animate-delay-500'];

const features = [
  {
    title: 'SFU-grade media',
    body: 'mediasoup routes every stream server-side, so 500 viewers cost one upload — not 500.',
    icon: (
      <path
        d="M4 7.5A2.5 2.5 0 0 1 6.5 5h6A2.5 2.5 0 0 1 15 7.5v9A2.5 2.5 0 0 1 12.5 19h-6A2.5 2.5 0 0 1 4 16.5v-9Zm11.5 2.7 3.4-2.1a.8.8 0 0 1 1.2.7v6.4a.8.8 0 0 1-1.2.7l-3.4-2.1"
        strokeWidth="1.6"
      />
    ),
  },
  {
    title: 'Role-aware visibility',
    body: 'Participants only ever receive staff media and approved speakers. Enforced on the server.',
    icon: (
      <path
        d="M12 3.5 5 6.5v5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9v-5l-7-3Z"
        strokeWidth="1.6"
      />
    ),
  },
  {
    title: 'Live engagement',
    body: 'Chat, hand-raise queues, timed quizzes with live results, and one-click course offers.',
    icon: (
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4 3.5v-3.5A2.5 2.5 0 0 1 4 13.5v-7Z"
        strokeWidth="1.6"
      />
    ),
  },
  {
    title: 'Payments built in',
    body: 'Razorpay orders, signature verification and webhooks — with a mock mode for local dev.',
    icon: (
      <path
        d="M3.5 8.5A2.5 2.5 0 0 1 6 6h12a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 18H6a2.5 2.5 0 0 1-2.5-2.5v-7Zm0 2.5h17"
        strokeWidth="1.6"
      />
    ),
  },
];

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* ambient glow */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-brand-600/20 blur-[140px]" />
      <div className="pointer-events-none absolute right-0 top-1/3 h-[380px] w-[380px] rounded-full bg-accent-500/10 blur-[120px]" />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <nav className="flex items-center gap-2">
          <ConsoleLink className="btn-ghost text-xs sm:text-sm" />
          <Link href="/w/live-product-teardown" className="btn-primary text-xs sm:text-sm">
            Watch demo
          </Link>
        </nav>
      </header>

      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-16 pt-10 sm:pt-20">
        <div className="animate-fade-up">
          <span className="chip">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-mint-400" />
            </span>
            Production-ready webinar stack
          </span>
        </div>

        <h1 className="mt-6 max-w-3xl animate-fade-up text-4xl font-extrabold leading-[1.08] tracking-tight text-white animate-delay-100 sm:text-6xl">
          Run live webinars that feel{' '}
          <span className="text-gradient">effortlessly premium</span>
        </h1>

        <p className="mt-5 max-w-xl animate-fade-up text-base leading-relaxed text-slate-400 animate-delay-200 sm:text-lg">
          A complete platform: SFU media routing, role-based visibility, real-time chat and
          quizzes, Razorpay checkout, and an admin console — all in one monorepo.
        </p>

        <div className="mt-9 flex animate-fade-up flex-wrap items-center gap-3 animate-delay-300">
          <Link href="/w/live-product-teardown" className="btn-primary px-6 py-3 text-base">
            Join the live demo
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
              <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <ConsoleLink
            className="btn-ghost px-6 py-3 text-base"
            signedInLabel="Open admin console"
            signedOutLabel="Open admin console"
          />
        </div>

        {/* feature grid */}
        <div className="mt-20 grid gap-4 sm:grid-cols-2">
          {features.map((f, i) => (
            <div
              key={f.title}
              className={`card group animate-fade-up p-6 transition-all duration-300 hover:border-white/20 hover:bg-white/[0.06] ${DELAYS[i % DELAYS.length]}`}
            >
              <div className="mb-4 grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-brand-500/25 to-brand-700/10 text-brand-200 transition group-hover:from-brand-400/35">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                  {f.icon}
                </svg>
              </div>
              <h3 className="text-base font-semibold text-white">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{f.body}</p>
            </div>
          ))}
        </div>

        {/* stats strip */}
        <div className="mt-16 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06] sm:grid-cols-4">
          {[
            ['500', 'Concurrent viewers'],
            ['<200ms', 'Glass-to-glass latency'],
            ['1', 'Upload per host'],
            ['100%', 'Server-enforced policy'],
          ].map(([value, label]) => (
            <div key={label} className="bg-ink-900/80 px-5 py-6 text-center">
              <div className="text-2xl font-bold text-white">{value}</div>
              <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-slate-500">
                {label}
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="relative z-10 border-t border-white/5 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 text-xs text-slate-500 sm:flex-row">
          <span>© {new Date().getFullYear()} NexaLive. Built with mediasoup, Next.js and Razorpay.</span>
          <span className="font-mono">v1.0.0</span>
        </div>
      </footer>
    </main>
  );
}
