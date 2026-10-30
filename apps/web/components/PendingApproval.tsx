'use client';

import Link from 'next/link';
import { Logo } from '@/components/Logo';

/**
 * Shown when a registration is parked in PENDING.
 *
 * A webinar with approval switched on does not let anyone in until a host says
 * so. The socket rejects the join with a specific message, and this screen
 * turns that rejection into something a person can act on — rather than the
 * generic "Could not join" card, which reads like a bug.
 */
export function PendingApproval({ slug, title }: { slug: string; title?: string }) {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo href="/" />
        </div>

        <div className="card p-8 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-amber-500/15 text-amber-300">
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <h1 className="text-lg font-semibold text-white">Waiting for approval</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            {title ? (
              <>
                Your registration for <span className="text-slate-200">{title}</span> is with the
                host.
              </>
            ) : (
              'Your registration is with the host.'
            )}{' '}
            You&apos;ll get an email the moment you&apos;re approved — the join link in it will
            bring you straight back here.
          </p>

          <div className="mt-6 flex flex-col gap-2">
            <Link href={`/w/${slug}`} className="btn-ghost w-full">
              Back to the webinar page
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
