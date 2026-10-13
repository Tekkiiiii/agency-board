"use client";

import { useRouter } from "next/navigation";
import { startTransition, type ReactNode } from "react";
import { ErrorState } from "../ErrorState";
import { PageHeader } from "../PageHeader";

// Shared body for every route error.tsx: the same page header (title, date, paused Live indicator) the
// page renders, optional page chrome (e.g. Memory tabs) so the layout does not jump, then one ErrorState.
// Retry re-fetches server data (router.refresh) and resets the boundary.
export function RouteError({
  title,
  subtitle,
  what,
  message,
  error,
  reset,
  children,
}: {
  title: string;
  subtitle?: string;
  what: string; // "task board", "access data" ... (title becomes "Task board unavailable")
  message?: ReactNode;
  error: Error & { digest?: string };
  reset: () => void;
  children?: ReactNode;
}) {
  const router = useRouter();
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} live={false} />
      {children}
      <ErrorState
        page
        title={`${what.charAt(0).toUpperCase()}${what.slice(1)} unavailable`}
        message={
          message ?? (
            <p>
              The dashboard could not read this data. If migration <span className="hub-mono">20261007000002_roles_grants</span> is
              not applied yet, this page stays unavailable until it is.
            </p>
          )
        }
        reference={error.digest}
        onRetry={retry}
      />
    </>
  );
}
