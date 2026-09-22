"use client";
/**
 * Branded boot overlay: covers the first paint while the client bundle
 * hydrates and the platform config loads (dev hydration can take a while).
 * Fades out on config / chain error, or after a hard 8s cap. Whichever first.
 */
import { useEffect, useState } from "react";
import { usePlatform } from "@/lib/platform";
import { KydoWordmark } from "./brand/Kydo";

export function BootSplash() {
  const { config, chainError } = usePlatform();
  const [phase, setPhase] = useState<"on" | "fading" | "off">("on");
  const ready = config !== null || chainError !== null;
  useEffect(() => {
    if (phase !== "on") return;
    const start = () => setPhase("fading");
    const t = ready ? setTimeout(start, 150) : setTimeout(start, 8000);
    return () => clearTimeout(t);
  }, [ready, phase]);
  useEffect(() => {
    if (phase !== "fading") return;
    const t = setTimeout(() => setPhase("off"), 350);
    return () => clearTimeout(t);
  }, [phase]);
  if (phase === "off") return null;
  return (
    <div className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-bg transition-opacity duration-300 ${phase === "fading" ? "opacity-0" : "opacity-100"}`} aria-hidden={phase === "fading"} role="status" aria-label="Loading">
      {/* The same mark the Header signs with, so the splash resolves into the
          app rather than cutting from one identity to another. Sized up from
          the Header's 30 because this one sits alone on a full screen. */}
      <KydoWordmark size={36} />
      <span className="boot-ring" aria-hidden />
      <span className="font-sans text-xxs text-muted">loading markets…</span>
    </div>
  );
}
