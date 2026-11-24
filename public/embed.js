/*!
 * OpenMeet embed SDK – AGPL-3.0
 *
 *   <script src="https://YOUR-INSTANCE/embed.js" async></script>
 *
 *   Popup:     <button data-openmeet="alice/30min">Book</button>
 *   Inline:    <div data-openmeet-inline="alice/30min"></div>
 *   Floating:  <script src=".../embed.js" data-openmeet-floating="alice/30min" data-label="Book a meeting"></script>
 *   Team:      data-openmeet="team/support/intro"
 *   Options:   data-theme="dark|light", data-color="#1f7a5c", data-prefill-name, data-prefill-email
 *
 * Events: window "openmeet:booked" (detail: { bookingId, startAt }).
 * Messages from the iframe are only accepted from the OpenMeet origin.
 */
(function () {
  "use strict";
  var script = document.currentScript || document.querySelector('script[src*="embed.js"]');
  if (!script) return;
  var ORIGIN = new URL(script.src, location.href).origin;
  if (window.__openmeetEmbed) return;
  window.__openmeetEmbed = true;

  function pathFor(target) {
    target = String(target || "").replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9._\/-]+$/.test(target)) return null;
    if (target.indexOf("team/") === 0 || target.indexOf("f/") === 0 || target.indexOf("book/") === 0) return "/" + target;
    return "/u/" + target;
  }

  function buildUrl(el, target) {
    var p = pathFor(target);
    if (!p) return null;
    var u = new URL(ORIGIN + p);
    u.searchParams.set("embed", "1");
    var theme = el.getAttribute("data-theme");
    if (theme === "dark" || theme === "light") u.searchParams.set("theme", theme);
    var name = el.getAttribute("data-prefill-name");
    var email = el.getAttribute("data-prefill-email");
    if (name) u.searchParams.set("name", name);
    if (email) u.searchParams.set("email", email);
    var here = new URL(location.href);
    here.searchParams.forEach(function (v, k) {
      if (k.indexOf("utm_") === 0) u.searchParams.set(k, v);
    });
    return u.toString();
  }

  function makeIframe(src, minHeight) {
    var f = document.createElement("iframe");
    f.src = src;
    f.title = "Book a meeting";
    f.loading = "lazy";
    f.allow = "clipboard-write";
    f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    f.style.cssText = "width:100%;border:0;display:block;min-height:" + (minHeight || 640) + "px;background:transparent;color-scheme:normal";
    return f;
  }

  var frames = [];
  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data;
    if (!d || d.source !== "openmeet") return;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow !== e.source) continue;
      if (d.type === "resize" && typeof d.height === "number") frames[i].style.height = Math.min(Math.max(d.height, 300), 4000) + "px";
      if (d.type === "booked") {
        window.dispatchEvent(new CustomEvent("openmeet:booked", { detail: { bookingId: String(d.bookingId || ""), startAt: Number(d.startAt) || null } }));
      }
    }
  });

  var overlay = null;
  function closePopup() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.documentElement.style.overflow = "";
  }
  function openPopup(el, target) {
    var src = buildUrl(el, target);
    if (!src) return;
    closePopup();
    overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Book a meeting");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(15,17,21,.55);display:flex;align-items:center;justify-content:center;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "position:relative;width:100%;max-width:1040px;max-height:calc(100vh - 32px);overflow:auto;border-radius:16px;background:#fff";
    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.style.cssText = "position:absolute;top:8px;right:10px;z-index:1;width:32px;height:32px;border:0;border-radius:16px;background:rgba(0,0,0,.06);font-size:20px;cursor:pointer";
    close.onclick = closePopup;
    var frame = makeIframe(src, 620);
    frames.push(frame);
    box.appendChild(close);
    box.appendChild(frame);
    overlay.appendChild(box);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closePopup();
    });
    document.addEventListener(
      "keydown",
      function esc(e) {
        if (e.key === "Escape") {
          closePopup();
          document.removeEventListener("keydown", esc);
        }
      },
    );
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = "hidden";
    close.focus();
  }

  function init() {
    document.querySelectorAll("[data-openmeet-inline]").forEach(function (el) {
      if (el.__om) return;
      el.__om = true;
      var src = buildUrl(el, el.getAttribute("data-openmeet-inline"));
      if (!src) return;
      var f = makeIframe(src, parseInt(el.getAttribute("data-min-height") || "640", 10));
      frames.push(f);
      el.appendChild(f);
    });
    document.querySelectorAll("[data-openmeet]").forEach(function (el) {
      if (el.__om) return;
      el.__om = true;
      el.addEventListener("click", function (e) {
        e.preventDefault();
        openPopup(el, el.getAttribute("data-openmeet"));
      });
    });
    var floating = script.getAttribute("data-openmeet-floating");
    if (floating && !document.getElementById("openmeet-floating")) {
      var b = document.createElement("button");
      b.id = "openmeet-floating";
      b.type = "button";
      b.textContent = script.getAttribute("data-label") || "Book a meeting";
      var color = script.getAttribute("data-color");
      if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) color = "#1f7a5c";
      b.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147482999;padding:12px 18px;border:0;border-radius:999px;color:#fff;font:600 14px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.18);background:" + color;
      b.addEventListener("click", function () {
        openPopup(script, floating);
      });
      document.body.appendChild(b);
    }
  }

  window.OpenMeet = { open: function (target) { openPopup(script, target); }, close: closePopup, init: init };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
