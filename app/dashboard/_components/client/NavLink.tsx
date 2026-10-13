"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

// Nav item with aria-current; `exact` for /dashboard (Overview) so sub-pages don't match it.
// In the narrow top bar the nav scrolls sideways; the active item is scrolled into view (nav only,
// never the page) so the current section and its count stay visible.
export function NavLink({ href, exact, className, children }: { href: string; exact?: boolean; className?: string; children: ReactNode }) {
  const path = usePathname() ?? "";
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const link = ref.current;
    const nav = link?.closest<HTMLElement>(".hub-nav");
    if (!active || !link || !nav || nav.scrollWidth <= nav.clientWidth) return;
    const l = link.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    if (l.left >= n.left && l.right <= n.right - 24) return;
    nav.scrollLeft += l.left - n.left - (n.width - l.width) / 2;
  }, [active]);
  return (
    <Link ref={ref} href={href} className={`${className ?? "hub-nav__link"}${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  );
}
