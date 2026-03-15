import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-surface flex flex-col">
      {/* Hero */}
      <section className="bg-navy-900 text-white py-16 sm:py-24 flex-1 flex items-center">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-[5rem] sm:text-[7rem] font-bold leading-none text-white/10 select-none mb-2">
            404
          </p>
          <h1 className="font-serif text-3xl sm:text-4xl font-bold text-white mb-4">
            Page not found
          </h1>
          <p className="text-white/55 text-base sm:text-lg mb-10 max-w-md mx-auto">
            The page you&apos;re looking for doesn&apos;t exist or may have moved.
            Head back and keep exploring.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-accent-500 hover:bg-accent-400 text-navy-900 text-sm font-semibold transition-colors"
            >
              Back to home
            </Link>
            <Link
              href="/news"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-white/20 hover:border-white/40 text-white/80 hover:text-white text-sm font-medium transition-colors"
            >
              Browse market news
            </Link>
            <Link
              href="/articles"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-white/20 hover:border-white/40 text-white/80 hover:text-white text-sm font-medium transition-colors"
            >
              Read articles
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
