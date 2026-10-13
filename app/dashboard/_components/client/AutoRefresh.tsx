"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

const INTERVAL_MS = 15_000;

// router.refresh() every 15 s while the tab is visible; refreshes immediately on return.
// `renderedAt` changes on every server render, which resets the "synced Ns ago" clock.
export function AutoRefresh({ renderedAt, enabled = true }: { renderedAt: number; enabled?: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = Date.now();
    setSyncedAt(t);
    setNow(t);
  }, [renderedAt]);

  useEffect(() => {
    const onVis = () => {
      const v = document.visibilityState === "visible";
      setVisible(v);
      if (v && enabled) startTransition(() => router.refresh());
    };
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled, router]);

  useEffect(() => {
    if (!enabled || !visible) return;
    const id = window.setInterval(() => startTransition(() => router.refresh()), INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, visible, router]);

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [visible]);

  const secs = syncedAt !== null && now !== null ? Math.max(0, Math.round((now - syncedAt) / 1000)) : 0;
  const ago = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`;
  const live = enabled && visible;

  return (
    <span className={`hub-live${live ? "" : " hub-live--paused"}`} title={live ? "Refreshes every 15 seconds" : "Auto-refresh paused"}>
      <span className="hub-live__dot" aria-hidden="true" />
      <span>{live ? "Live" : "Paused"}</span>
      <span className="hub-live__sep" aria-hidden="true">·</span>
      <span className="hub-mono">synced {ago} ago</span>
    </span>
  );
}
