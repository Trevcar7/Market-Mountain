"use client";

import { FormEvent, useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SubscribeCTA() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();

    if (!EMAIL_RE.test(trimmed)) {
      setStatus("error");
      setErrorMsg("Please enter a valid email address.");
      return;
    }

    setStatus("loading");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setStatus("error");
        setErrorMsg(data.error ?? "Something went wrong. Please try again.");
        return;
      }

      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMsg("Network error. Please try again.");
    }
  }

  return (
    <section className="bg-navy-900 border-t-2 border-accent-500/30">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          {/* Label */}
          <p className="text-xs font-semibold tracking-widest uppercase text-accent-500 mb-3">
            Stay Informed
          </p>

          {/* Heading */}
          <h2 className="text-2xl sm:text-3xl font-bold text-white font-playfair mb-3">
            Market insights, delivered.
          </h2>

          {/* Subtitle */}
          <p className="text-white/60 text-sm sm:text-base mb-8 max-w-lg mx-auto">
            Get market analysis, macro updates, and investment research
            straight to your inbox.
          </p>

          {/* Form / Success state */}
          {status === "success" ? (
            <div className="flex items-center justify-center gap-2 text-accent-400 font-medium">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M6 10l3 3 5-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle
                  cx="10"
                  cy="10"
                  r="8.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
              You&apos;re in! We&apos;ll be in touch.
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
            >
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (status === "error") setStatus("idle");
                }}
                placeholder="you@example.com"
                required
                className="flex-1 px-4 py-3 rounded-lg bg-white/10 border border-white/15 text-white placeholder-white/40 text-sm focus:outline-none focus:border-accent-500 focus:ring-1 focus:ring-accent-500/30 transition-colors"
              />
              <button
                type="submit"
                disabled={status === "loading"}
                className="px-6 py-3 rounded-lg bg-accent-500 hover:bg-accent-400 text-navy-950 font-semibold text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
              >
                {status === "loading" ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg
                      className="animate-spin h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="3"
                        className="opacity-25"
                      />
                      <path
                        d="M4 12a8 8 0 018-8"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                      />
                    </svg>
                    Subscribing…
                  </span>
                ) : (
                  "Subscribe"
                )}
              </button>
            </form>
          )}

          {/* Error message */}
          {status === "error" && errorMsg && (
            <p className="mt-3 text-red-400 text-sm">{errorMsg}</p>
          )}

          {/* Privacy note */}
          {status !== "success" && (
            <p className="mt-4 text-white/30 text-xs">
              No spam. Unsubscribe anytime.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
