import type { ReactNode } from "react";

export function Logo({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.6" className="text-accent-ink" />
      <path d="M16 11.5V16l3 2" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" className="text-accent-ink" />
    </svg>
  );
}

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-5 py-12">
      <div className="w-full max-w-[380px] animate-rise">
        <div className="mb-8 flex items-center gap-2">
          <Logo />
          <span className="font-display text-lg font-semibold">OpenMeet</span>
        </div>
        <h1 className="text-[28px] leading-tight">{title}</h1>
        {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
        <div className="mt-8">{children}</div>
        {footer && <div className="mt-8 border-t border-line pt-5 text-[13px] text-muted">{footer}</div>}
      </div>
    </main>
  );
}
