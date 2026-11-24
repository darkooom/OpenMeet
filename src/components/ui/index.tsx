/**
 * OpenMeet UI kit – small, accessible primitives in the spirit of shadcn/ui
 * (copy-in components styled with Tailwind; no runtime UI dependency).
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ChevronDown, Loader2, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110 shadow-[inset_0_-1px_0_rgba(0,0,0,0.15)]",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-raised",
  ghost: "text-muted hover:text-ink hover:bg-raised",
  danger: "bg-surface text-danger border border-line-strong hover:bg-danger-soft",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  lg: "h-11 px-5 text-[15px] gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant = "secondary", size = "md", loading, disabled, children, type = "button", ...rest }, ref) => (
  <button
    ref={ref}
    type={type}
    disabled={disabled || loading}
    className={cn(
      "inline-flex items-center justify-center rounded-[var(--radius-control)] font-medium whitespace-nowrap transition-[background,filter,color] disabled:opacity-50 disabled:pointer-events-none select-none",
      variants[variant],
      sizes[size],
      className,
    )}
    {...rest}
  >
    {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
    {children}
  </button>
));
Button.displayName = "Button";

const control =
  "w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-faint transition-colors focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60 aria-[invalid=true]:border-danger";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={cn(control, "h-9", className)} {...rest} />
));
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={cn(control, "py-2 min-h-[84px] leading-relaxed", className)} {...rest} />
));
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...rest }, ref) => (
  <div className={cn("relative", className)}>
    <select ref={ref} className={cn(control, "h-9 pr-8 appearance-none")} {...rest}>
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
  </div>
));
Select.displayName = "Select";

export function Field({ label, hint, error, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12.5px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled, description }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; description?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 py-1">
      <div>
        <label htmlFor={id} className="text-sm font-medium text-ink cursor-pointer">
          {label}
        </label>
        {description && <p className="text-[12.5px] text-muted mt-0.5">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 mt-0.5", checked ? "bg-accent" : "bg-line-strong")}
      >
        <span className={cn("absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform", checked && "translate-x-4")} />
      </button>
    </div>
  );
}

const badgeTones = {
  neutral: "bg-raised text-muted",
  accent: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
};
export function Badge({ tone = "neutral", children, className }: { tone?: keyof typeof badgeTones; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium", badgeTones[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-5 animate-spin text-faint", className)} aria-label="Loading" />;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-muted max-w-[62ch]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cn("rounded-[var(--radius-panel)] border border-line bg-surface", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          {title && <h2 className="text-[15px] font-semibold font-sans tracking-normal">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 px-6 py-10">
      {icon && <div className="text-faint mb-1">{icon}</div>}
      <p className="font-medium text-ink">{title}</p>
      {children && <p className="text-muted max-w-[52ch]">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {children}
    </div>
  );
}

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className={cn("m-auto w-[calc(100%-2rem)] rounded-[var(--radius-panel)] border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40", wide ? "max-w-2xl" : "max-w-md")}
    >
      {open && (
        <div className="animate-rise">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="text-[16px] font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted hover:text-ink">
              <X className="size-4" />
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          type="button"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors", value === it.value ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
