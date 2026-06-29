"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/";

  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasUsers, setHasUsers] = useState(true);

  useEffect(() => {
    fetch("/api/auth-status")
      .then((res) => res.json())
      .then((data) => {
        const existing = data.hasUsers === true;
        setHasUsers(existing);
        if (!existing) setIsSignUp(true);
      })
      .catch(() => {
        setHasUsers(true);
      });
  }, []);

  // Force sign-in mode when users exist
  const effectiveSignUp = hasUsers ? false : isSignUp;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || (effectiveSignUp && !name)) {
      toast.error("Please fill in all fields");
      return;
    }

    setLoading(true);

    try {
      if (effectiveSignUp) {
        const { error } = await authClient.signUp.email({
          email,
          password,
          name,
        });

        if (error) {
          toast.error(error.message || "Failed to sign up");
        } else {
          toast.success("Account created successfully!");
          router.push(callbackUrl);
          router.refresh();
        }
      } else {
        const { error } = await authClient.signIn.email({
          email,
          password,
        });

        if (error) {
          toast.error(error.message || "Invalid credentials");
        } else {
          toast.success("Signed in successfully!");
          router.push(callbackUrl);
          router.refresh();
        }
      }
    } catch (err: any) {
      toast.error(err.message || "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md space-y-8 z-10">
      <div className="flex flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600 font-bold text-xl text-white shadow-lg shadow-violet-500/20">
          NF
        </div>
        <h2 className="mt-6 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
          {isSignUp ? "Create Admin Account" : "Sign in to NotFair"}
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          {isSignUp
            ? "Register your admin user for server hosting"
            : "Access your local SEO & ad management dashboard"}
        </p>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 backdrop-blur-xl shadow-2xl">
        <form className="space-y-6" onSubmit={handleSubmit}>
          {effectiveSignUp && (
            <div>
              <label htmlFor="name" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Full Name
              </label>
              <div className="mt-1.5">
                <input
                  id="name"
                  name="name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter your name"
                  className="block w-full rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-2.5 text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 text-sm transition-colors"
                />
              </div>
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Email Address
              </label>
              <div className="mt-1.5">
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="block w-full rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-2.5 text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 text-sm transition-colors"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Password
                </label>
              </div>
              <div className="mt-1.5">
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="block w-full rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-2.5 text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 text-sm transition-colors"
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="group relative flex w-full justify-center rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-violet-500/10"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <svg className="h-4 w-4 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Processing...
                  </span>
                ) : effectiveSignUp ? (
                  "Create Account"
                ) : (
                  "Sign In"
                )}
              </button>
            </div>
          </form>

          {!hasUsers && (
            <div className="mt-6 flex justify-center text-sm">
              <button
                onClick={() => setIsSignUp(!isSignUp)}
                className="text-xs font-semibold text-violet-400 hover:text-violet-300 transition-colors"
              >
                {isSignUp ? "Already have an account? Sign In" : "Need to register? Create Admin Account"}
              </button>
            </div>
          )}
        </div>
      </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 py-12 text-zinc-100 sm:px-6 lg:px-8">
      {/* Background Glows */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-[40%] -left-[20%] h-[80%] w-[60%] rounded-full bg-violet-900/10 blur-[120px]" />
        <div className="absolute -bottom-[40%] -right-[20%] h-[80%] w-[60%] rounded-full bg-indigo-900/10 blur-[120px]" />
      </div>

      <Suspense fallback={
        <div className="flex flex-col items-center justify-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600 font-bold text-xl text-white shadow-lg animate-pulse">
            NF
          </div>
          <div className="mt-4 text-zinc-500 text-sm">Loading...</div>
        </div>
      }>
        <LoginForm />
      </Suspense>
    </div>
  );
}
