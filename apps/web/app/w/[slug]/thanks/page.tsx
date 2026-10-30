'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Logo } from '@/components/Logo';
import { endpoints, API_URL, type PublicWebinar } from '@/lib/api';

export default function ThanksPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? '';
  const [webinar, setWebinar] = useState<PublicWebinar | null>(null);

  useEffect(() => {
    endpoints
      .publicWebinar(slug)
      .then((res) => setWebinar(res.webinar))
      .catch(() => undefined);
  }, [slug]);

  return (
    <main className="relative grid min-h-screen place-items-center px-6 py-12">
      <div className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-mint-500/15 blur-[130px]" />

      <div className="relative w-full max-w-md text-center">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="card p-8">
          <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full bg-mint-500/15 text-mint-400">
            <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="m5 13 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <h1 className="text-xl font-semibold text-white">You&apos;re all set</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            {webinar
              ? `Your seat for "${webinar.title}" is confirmed. We'll email you a reminder before it starts.`
              : 'Your registration is confirmed. We will email you a reminder before the session.'}
          </p>

          <Link href={`/room/${slug}`} className="btn-primary mt-6 w-full py-3">
            Enter the room
          </Link>
          <a
            href={`${API_URL}/api/webinars/${slug}/calendar.ics`}
            className="btn-ghost mt-2 w-full"
            // The server sets Content-Disposition, so this downloads rather
            // than navigating away from the confirmation page.
            download
          >
            Add to calendar
          </a>
          <Link href={`/w/${slug}`} className="btn-ghost mt-2 w-full">
            Back to webinar page
          </Link>
        </div>
      </div>
    </main>
  );
}
