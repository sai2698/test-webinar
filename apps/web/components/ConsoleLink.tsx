'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getToken } from '@/lib/session';

/**
 * A console link that knows whether you are already signed in.
 *
 * The landing page is a server component, so it cannot read `localStorage` —
 * and it should not, because the answer differs per browser. This renders the
 * sign-in destination on the server and corrects itself on mount, which means
 * a signed-in host clicking "Site" from the console and then "Console" gets
 * taken straight back to the dashboard instead of being asked to sign in again.
 *
 * The label changes with the destination. A link that says "Host sign in" and
 * lands on a dashboard is its own small lie.
 */
export function ConsoleLink({
  className,
  signedInLabel = 'Open console',
  signedOutLabel = 'Host sign in',
}: {
  className?: string;
  signedInLabel?: string;
  signedOutLabel?: string;
}) {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    // `getToken` treats an expired JWT as no session, so a stale token still
    // offers the sign-in link rather than a dashboard that cannot load.
    setSignedIn(Boolean(getToken('admin')));
  }, []);

  return (
    <Link href={signedIn ? '/admin' : '/admin/login'} className={className}>
      {signedIn ? signedInLabel : signedOutLabel}
    </Link>
  );
}
