import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Console — Nexa Live',
};

/**
 * The console subtree owns its own theme, so the stored preference is applied
 * to <html> before React hydrates. Without this the first paint is always the
 * dark default and the page visibly flips once the provider mounts.
 *
 * The class is removed again on unmount so the dark-only marketing, room and
 * replay pages are never affected by a leftover light theme.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem('nexa:theme');
    var root = document.documentElement;
    if (stored === 'light') {
      root.classList.add('theme-light');
      root.classList.remove('dark');
    } else {
      root.classList.add('dark');
      root.classList.remove('theme-light');
    }
  } catch (e) {}
})();
`;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      {children}
    </>
  );
}
