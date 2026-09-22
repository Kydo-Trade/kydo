"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Drag handle between two columns. Mouse drag or ←/→ (16 px steps) call
 * `onDelta` with the horizontal movement; the parent clamps and stores widths.
 */
export function Gutter({ onDelta, label }: { onDelta: (dx: number) => void; label: string }) {
  const [dragging, setDragging] = useState(false);
  const lastX = useRef(0);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      onDelta(e.clientX - lastX.current);
      lastX.current = e.clientX;
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prev;
      document.body.style.cursor = "";
    };
  }, [dragging, onDelta]);

  return (
    <div
      className={`gutter ${dragging ? "bg-accent/40" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag or use ← → to resize"
      onMouseDown={(e) => {
        e.preventDefault();
        lastX.current = e.clientX;
        setDragging(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onDelta(-16);
        else if (e.key === "ArrowRight") onDelta(16);
        else return;
        e.preventDefault();
      }}
    />
  );
}
