// Applies the stored colour theme before first paint (external file: CSP forbids inline scripts).
(function () {
  try {
    var t = localStorage.getItem("om-theme") || "system";
    var dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
})();
