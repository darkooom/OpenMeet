# Embedding OpenMeet

`embed.js` is served by your instance. Targets: `<username>/<event>` or `team/<team>/<event>` (also `f/<formId>` for routing forms).

## HTML

```html
<!-- Inline -->
<div data-openmeet-inline="alice/30min" style="min-height:640px"></div>

<!-- Popup -->
<button data-openmeet="alice/30min" data-theme="light">Book a meeting</button>

<!-- Floating button -->
<script src="https://meet.example.com/embed.js" data-openmeet-floating="alice/30min" data-label="Book a call" data-color="#1f7a5c" async></script>

<script src="https://meet.example.com/embed.js" async></script>
```

Options: `data-theme="dark|light"`, `data-prefill-name`, `data-prefill-email`, `data-min-height` (inline). UTM parameters of the host page are forwarded for analytics.

Events: `window.addEventListener("openmeet:booked", (e) => console.log(e.detail.bookingId, e.detail.startAt))`.
API: `window.OpenMeet.open("alice/30min")`, `window.OpenMeet.close()`, `window.OpenMeet.init()` (re-scan the DOM after client-side rendering).

Security: the iframe talks to the page via `postMessage`; the SDK accepts messages only from the OpenMeet origin and only from its own iframes. Public booking pages allow framing (`frame-ancestors *`); the dashboard does not.

## React

```tsx
import { useEffect } from "react";

export function BookingWidget({ target }: { target: string }) {
  useEffect(() => {
    const s = document.createElement("script");
    s.src = "https://meet.example.com/embed.js";
    s.async = true;
    s.onload = () => (window as any).OpenMeet?.init();
    document.body.appendChild(s);
    return () => s.remove();
  }, []);
  return <div data-openmeet-inline={target} style={{ minHeight: 640 }} />;
}
```

## Next.js (App Router)

```tsx
"use client";
import Script from "next/script";

export default function Book() {
  return (
    <>
      <div data-openmeet-inline="alice/30min" style={{ minHeight: 640 }} />
      <Script src="https://meet.example.com/embed.js" strategy="afterInteractive" onLoad={() => (window as any).OpenMeet?.init()} />
    </>
  );
}
```

## WordPress

Add a **Custom HTML** block with the HTML snippet above (inline or popup). For a site-wide floating button, put the floating `<script>` into your theme footer or a "header & footer scripts" plugin.

## Webflow

Add an **Embed** element with the inline or popup snippet. For a floating button use *Project settings → Custom code → Footer code*.

## Plain iframe

```html
<iframe src="https://meet.example.com/u/alice/30min?embed=1" style="width:100%;min-height:680px;border:0" title="Book a meeting"></iframe>
```
