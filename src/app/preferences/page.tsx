"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";

function PreferencesContent() {
  const searchParams = useSearchParams();
  const unsubscribed = searchParams.get("unsubscribed") === "true";

  return (
    <main className="min-h-screen bg-surface">
      <div className="mx-auto max-w-lg px-4 py-16 sm:py-24">
        {unsubscribed ? (
          <div className="bg-card rounded-xl shadow-sm border border-border p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-accent-500/15 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-accent-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-text font-serif mb-2">
              You have been unsubscribed
            </h1>
            <p className="text-text-muted text-sm leading-relaxed mb-6">
              You will no longer receive emails from Market Mountain.
              If this was a mistake, you can re-subscribe at any time.
            </p>
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent-500 text-navy-900 font-semibold text-sm rounded-lg hover:bg-accent-600 transition-colors"
            >
              Return to Market Mountain
            </Link>
          </div>
        ) : (
          <div className="bg-card rounded-xl shadow-sm border border-border p-8">
            <h1 className="text-xl font-semibold text-text font-serif mb-2">
              Email Preferences
            </h1>
            <p className="text-text-muted text-sm leading-relaxed mb-6">
              Manage your Market Mountain email subscription.
            </p>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-surface rounded-lg border border-border">
                <div>
                  <p className="text-sm font-medium text-text">Daily Markets Briefing</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    Lead story, key data, and what to watch — every trading day at 8 AM ET
                  </p>
                </div>
                <div className="w-10 h-6 bg-accent-500 rounded-full relative cursor-default" title="Active">
                  <div className="absolute right-0.5 top-0.5 w-5 h-5 bg-white rounded-full shadow" />
                </div>
              </div>

              <div className="flex items-center justify-between p-4 bg-surface rounded-lg border border-border">
                <div>
                  <p className="text-sm font-medium text-text">Research Alerts</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    New equity research and price target updates
                  </p>
                </div>
                <div className="w-10 h-6 bg-accent-500 rounded-full relative cursor-default" title="Active">
                  <div className="absolute right-0.5 top-0.5 w-5 h-5 bg-white rounded-full shadow" />
                </div>
              </div>
            </div>

            <p className="text-xs text-text-light mt-6">
              To unsubscribe from all emails, click the unsubscribe link in any email footer.
            </p>

            <div className="mt-8 pt-6 border-t border-border">
              <Link
                href="/"
                className="text-sm text-accent-600 hover:text-accent-700 font-medium"
              >
                &larr; Back to Market Mountain
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export default function PreferencesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-surface" />}>
      <PreferencesContent />
    </Suspense>
  );
}
