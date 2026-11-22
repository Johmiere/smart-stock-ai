(() => {
  "use strict";

  function element(tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label) node.textContent = label;
    return node;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const page = document.body.dataset.page;
    const main = document.querySelector(".admin-body .main-content");
    const menu = document.querySelector(".sidebar .menu");
    if (!page || !main || !menu) return;

    const offline = element("p", "mobile-offline", "Offline · Check your connection before saving.");
    offline.setAttribute("role", "status");
    main.prepend(offline);
    const syncNetwork = () => { offline.hidden = navigator.onLine; };
    window.addEventListener("online", syncNetwork);
    window.addEventListener("offline", syncNetwork);
    syncNetwork();

    const nav = element("nav", "mobile-tabbar");
    nav.setAttribute("aria-label", "Store navigation");
    const tabs = [
      ["Home", "⌂", "/daily-digest.html", page === "dashboard" || page === "daily-digest"],
      ["Items", "▦", "/products.html", page === "products"],
      ["POS", "+", "/sales.html", page === "sales", "mobile-sale-tab"],
      ["Ask AI", "✦", "/daily-digest.html#daily-assistant", false, "mobile-assistant-tab"],
    ];
    let home;
    let assistant;
    for (const [title, symbol, href, active, style] of tabs) {
      const anchor = element("a", style);
      anchor.href = href;
      if (active) anchor.setAttribute("aria-current", "page");
      const icon = element("span", "mobile-tab-icon", symbol);
      icon.setAttribute("aria-hidden", "true");
      anchor.append(icon, element("span", "", title));
      nav.append(anchor);
      if (title === "Home") home = anchor;
      if (title === "Ask AI") assistant = anchor;
    }

    if (page === "daily-digest") {
      const syncSection = () => {
        const asking = location.hash === "#daily-assistant";
        (asking ? assistant : home).setAttribute("aria-current", asking ? "location" : "page");
        (asking ? home : assistant).removeAttribute("aria-current");
      };
      syncSection();
      window.addEventListener("hashchange", syncSection);
    }

    const more = element("button", "mobile-more-tab");
    more.type = "button";
    more.setAttribute("aria-haspopup", "dialog");
    more.setAttribute("aria-controls", "mobile-more-dialog");
    if (!tabs.some((tab) => tab[3])) more.dataset.current = "true";
    const moreIcon = element("span", "mobile-tab-icon", "···");
    moreIcon.setAttribute("aria-hidden", "true");
    more.append(moreIcon, element("span", "", "More"));
    nav.append(more);

    const dialog = element("dialog", "mobile-more-dialog");
    dialog.id = "mobile-more-dialog";
    dialog.setAttribute("aria-labelledby", "mobile-more-heading");
    const title = element("h3", "", "More");
    title.id = "mobile-more-heading";
    const closeForm = element("form");
    closeForm.method = "dialog";
    const close = element("button", "btn btn-secondary", "Close");
    closeForm.append(close);
    const header = element("header");
    header.append(title, closeForm);
    const links = element("nav", "mobile-more-links");
    links.setAttribute("aria-label", "Other store pages");
    const logOut = element("button", "btn btn-secondary", "Logout");
    logOut.type = "button";
    dialog.append(header, links, logOut);
    document.body.append(nav, dialog);

    more.addEventListener("click", () => {
      links.replaceChildren();
      for (const anchor of menu.querySelectorAll("a[href]")) {
        if (["/products.html", "/sales.html", "/daily-digest.html"].includes(new URL(anchor.href).pathname)) continue;
        const copy = element("a", "", anchor.textContent.trim());
        copy.href = anchor.href;
        if (anchor.hasAttribute("aria-current")) copy.setAttribute("aria-current", "page");
        links.append(copy);
      }
      dialog.showModal();
    });
    logOut.addEventListener("click", () => {
      dialog.close();
      main.querySelector("[data-logout]")?.click();
    });
    const desktop = window.matchMedia("(min-width: 761px)");
    desktop.addEventListener("change", (event) => { if (event.matches && dialog.open) dialog.close(); });
    document.documentElement.dataset.mobileShell = "ready";
  });
  document.addEventListener("smart-stock:ready", () => {
    const greeting = document.getElementById("mobile-dashboard-title");
    if (greeting && typeof currentUser !== "undefined" && currentUser?.first_name) {
      greeting.textContent = "Welcome, " + currentUser.first_name + "!";
    }
  }, { once: true });
})();
