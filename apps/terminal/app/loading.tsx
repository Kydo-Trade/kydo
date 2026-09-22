/** Route-level loading UI (app router). Shown during page transitions. */
export default function Loading() {
  return (
    <div className="w-full h-full min-h-[40vh] flex items-center justify-center" role="status" aria-label="Loading page">
      <span className="boot-ring" aria-hidden />
    </div>
  );
}
