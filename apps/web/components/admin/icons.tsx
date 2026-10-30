import type { SVGProps } from 'react';

/**
 * Inline icon set for the console.
 *
 * Hand-rolled rather than pulled from a package: the console needs about a
 * dozen glyphs, and a dependency would ship a whole icon library for them.
 * Every icon is a 24×24 stroke path so they line up on the same optical grid.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconVideo(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="6" width="12" height="12" rx="2.5" />
      <path d="m15 10.5 4.2-2.4a.8.8 0 0 1 1.2.7v6.4a.8.8 0 0 1-1.2.7L15 13.5" />
    </Base>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.4a3.2 3.2 0 0 1 0 5.2M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
    </Base>
  );
}

export function IconChart(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 15.5v-3M12.5 15.5v-7M17 15.5v-5" />
    </Base>
  );
}

export function IconSpark(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z" />
      <path d="M18.5 16.5 19.2 18.6 21.3 19.3 19.2 20 18.5 22.1 17.8 20 15.7 19.3 17.8 18.6 18.5 16.5Z" />
    </Base>
  );
}

export function IconCard(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.8" y="5.5" width="18.4" height="13" rx="2.6" />
      <path d="M2.8 10h18.4" />
      <path d="M6.5 14.5h3" />
    </Base>
  );
}

export function IconDisc(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.6" />
    </Base>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 5v14M5 12h14" />
    </Base>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </Base>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />
    </Base>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Base>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Base>
  );
}

export function IconLogout(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M15 4.5h2.5A2.5 2.5 0 0 1 20 7v10a2.5 2.5 0 0 1-2.5 2.5H15" />
      <path d="M10 8.5 6.5 12l3.5 3.5M6.5 12H15" />
    </Base>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M13.5 4.5H19.5V10.5" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 14.5v3.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" />
    </Base>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M8 5.5 18.5 12 8 18.5v-13Z" />
    </Base>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" />
      <path d="m13.5 7 3.5 3.5" />
    </Base>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.5 7l.8 11.3A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.7L17.5 7" />
      <path d="M10.5 11v5M13.5 11v5" />
    </Base>
  );
}

export function IconSend(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M20.5 3.5 3.8 10.2a.6.6 0 0 0 .05 1.1l6.4 2.4 2.4 6.4a.6.6 0 0 0 1.1.05L20.5 3.5Z" />
      <path d="M20.5 3.5 10.3 13.7" />
    </Base>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </Base>
  );
}

export function IconChevron(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m9 6 6 6-6 6" />
    </Base>
  );
}
