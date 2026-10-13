import type { ReactNode } from "react";

// Machine text: agent@machine, ids, token prefixes, model names, timestamps.
export function Mono({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`hub-mono${className ? ` ${className}` : ""}`} title={title}>
      {children}
    </span>
  );
}
