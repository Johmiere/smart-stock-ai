(() => {
  "use strict";

  const status = document.getElementById("workspace-loading");
  const label = document.getElementById("workspace-loading-label");
  const main = document.querySelector("main");
  if (!document.body.classList.contains("admin-body") || !status || !label || !main) return;

  const pages = new Map([
    ["/dashboard.html", "dashboard"], ["/products.html", "products"],
    ["/stock-history.html", "stock history"], ["/sales.html", "sales"],
    ["/low-stock.html", "stock alerts"], ["/reports.html", "reports"], ["/users.html", "user management"],
    ["/reorder.html", "suggested purchase orders"], ["/assets/reorder.html", "suggested purchase orders"],
    ["/daily-digest.html", "daily digest"]
  ]);
  const root = document.documentElement;
  let pageReady = false;
  let navigationTimer;

  function updateLoading(mode, message) {
    if (mode) root.dataset.workspaceLoading = mode;
    else delete root.dataset.workspaceLoading;
    status.hidden = !mode;
    label.textContent = message || "";
  }

  function showCurrentPage() {
    updateLoading(pageReady ? null : "page", pageReady ? "" : "Loading page data…");
  }

  main.setAttribute("aria-busy", "true");
  showCurrentPage();
  document.addEventListener("smart-stock:ready", () => {
    pageReady = true;
    main.removeAttribute("aria-busy");
    if (root.dataset.workspaceLoading !== "navigation") showCurrentPage();
  }, { once: true });

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.("a[href]");
    if (!link || link.hasAttribute("download") || link.closest("[aria-disabled='true'], [inert]")) return;
    const target = link.getAttribute("target") || document.querySelector("base[target]")?.target;
    if (target && target.toLowerCase() !== "_self") return;

    const destination = new URL(link.href, window.location.href);
    const destinationName = pages.get(destination.pathname);
    if (destination.origin !== window.location.origin || !destinationName ||
        (destination.pathname === window.location.pathname && destination.search === window.location.search)) return;

    updateLoading("navigation", "Opening " + destinationName + "…");
    window.clearTimeout(navigationTimer);
    navigationTimer = window.setTimeout(showCurrentPage, 12000);
  });

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      window.clearTimeout(navigationTimer);
      showCurrentPage();
    }
  });
})();
