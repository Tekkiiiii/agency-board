import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string {
  return `hub-btn hub-btn--${variant} hub-btn--${size}${extra ? ` ${extra}` : ""}`;
}

type Common = { variant?: ButtonVariant; size?: ButtonSize; children: ReactNode; className?: string };

// Primary = amber (one per view), secondary = outline, danger = red (destructive only).
// With `href` renders a Link styled as a button.
export function Button(props: Common & ({ href: string } | ({ href?: undefined } & ButtonHTMLAttributes<HTMLButtonElement>))) {
  const { variant, size, children, className } = props;
  const cls = buttonClass(variant, size, className);
  if (props.href !== undefined) {
    return (
      <Link href={props.href} className={cls}>
        {children}
      </Link>
    );
  }
  const { variant: _v, size: _s, className: _c, children: _ch, href: _h, type, ...rest } = props;
  return (
    <button type={type ?? "button"} className={cls} {...rest}>
      {children}
    </button>
  );
}
