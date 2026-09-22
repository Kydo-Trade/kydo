import Link from "next/link";

/** App-router 404. Rendered inside the root layout, so the header/nav stay. */
export default function NotFound() {
  return (
    <div className="w-full flex items-center justify-center px-4 py-24">
      <div className="panel px-8 py-10 max-w-md w-full flex flex-col items-center gap-4 text-center">
        <div className="num text-5xl font-semibold text-amber" aria-hidden>
          404
        </div>
        <h1 className="font-sans text-lg font-semibold text-fg">This page doesn&apos;t exist</h1>
        <p className="font-sans text-xs text-muted leading-relaxed">
          The address may be mistyped, or it pointed at a pool or trader that has been closed. Everything that exists is reachable from the pages below.
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          <Link href="/" className="btn btn-primary h-9 px-4 font-semibold">
            Home
          </Link>
          <Link href="/terminal" className="btn h-9 px-4">
            Terminal
          </Link>
          <Link href="/invest" className="btn h-9 px-4">
            Invest
          </Link>
          <Link href="/guide" className="btn h-9 px-4">
            Rulebook
          </Link>
        </div>
      </div>
    </div>
  );
}
