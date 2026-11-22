(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const smallScreen = window.matchMedia("(max-width: 760px)");
  const pesos = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function badge(kind, icon, label) {
    const chip = element("span", "mobile-stock-badge mobile-stock-" + kind);
    const mark = element("span", "mobile-stock-mark", icon);
    mark.setAttribute("aria-hidden", "true");
    chip.append(mark, document.createTextNode(label));
    return chip;
  }

  function startPOS() {
    const picker = byId("pos-product-picker");
    const categories = byId("pos-product-categories");
    const search = byId("pos-product-search");
    const grid = byId("pos-product-grid");
    const empty = byId("pos-product-empty");
    const count = byId("pos-product-count");
    const feedback = byId("pos-product-feedback");
    const barcode = byId("sale-barcode");
    const add = byId("add-cart-item");
    const scanPreview = byId("scan-preview");
    const message = byId("page-message");
    let products = [];
    let category = "";
    let nextFocus;
    let fromGrid = false;
    let catalogRequest = 0;

    function availableLabel(product) {
      const onHand = Number(product.product_quantity) || 0;
      return onHand === 0 ? badge("danger", "!", "Out of stock") :
        onHand <= Number(product.reorder_level || 0) ? badge("warning", "!", onHand + " on hand") :
          badge("available", "✓", onHand + " on hand");
    }

    function showProducts() {
      const query = search.value.trim().toLowerCase();
      const filtered = products.filter((product) => (
        (!category || product.product_category === category) &&
        (product.product_name + " " + product.product_barcode).toLowerCase().includes(query)
      ));
      count.textContent = filtered.length + (filtered.length === 1 ? " item" : " items");
      empty.textContent = products.length ? "No items match your search." : "No products yet. Add your first product in Items.";
      empty.hidden = filtered.length > 0;
      grid.replaceChildren(...filtered.map((product) => {
        const name = product.product_name;
        const code = product.product_barcode;
        const price = pesos.format(Number(product.product_price || 0));
        const card = element("button", "mobile-pos-product");
        card.type = "button";
        card.disabled = Number(product.product_quantity) <= 0;
        card.setAttribute("aria-label", "Add one " + name + " to cart, " + price);
        const picture = element("span", "mobile-pos-product-mark", (product.product_category || "Item").slice(0, 2).toUpperCase());
        picture.setAttribute("aria-hidden", "true");
        card.append(
          picture,
          element("strong", "mobile-pos-product-name", name),
          element("span", "mobile-pos-product-code", code),
          element("span", "mobile-pos-product-price", price),
          availableLabel(product),
        );
        card.addEventListener("click", () => {
          if (add.disabled || card.disabled) return;
          fromGrid = true;
          nextFocus = card;
          feedback.className = "notice";
          feedback.textContent = "Adding " + name + "…";
          barcode.value = code;
          byId("sale-quantity").value = "1";
          add.click();
        });
        return card;
      }));
    }

    function showCategories() {
      const values = Array.from(new Set(products.map((item) => item.product_category).filter(Boolean))).sort();
      if (!values.includes(category)) category = "";
      categories.replaceChildren(...["", ...values].map((value) => {
        const chip = element("button", "", value || "All");
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(value === category));
        chip.addEventListener("click", () => {
          category = value;
          for (const button of categories.querySelectorAll("button")) {
            button.setAttribute("aria-pressed", String(button === chip));
          }
          showProducts();
        });
        return chip;
      }));
    }

    async function loadCatalog() {
      const request = ++catalogRequest;
      try {
        const result = await api("/api/products");
        if (request !== catalogRequest) return;
        products = result;
        showCategories();
        showProducts();
      } catch (error) {
        if (request !== catalogRequest) return;
        feedback.className = "notice error";
        feedback.textContent = "Could not load the catalog. " + error.message;
      }
    }
    search.addEventListener("input", showProducts);
    barcode.addEventListener("focus", () => {
      if (!nextFocus) return;
      const target = nextFocus;
      nextFocus = null;
      if (target.isConnected) target.focus({ preventScroll: true });
    });
    new MutationObserver(() => {
      if (fromGrid && (scanPreview.classList.contains("success") || scanPreview.classList.contains("error"))) {
        feedback.textContent = scanPreview.textContent;
        feedback.className = scanPreview.className;
        fromGrid = false;
      }
    }).observe(scanPreview, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
    new MutationObserver(() => {
      if (message.classList.contains("success") && message.textContent.includes("Receipt #")) {
        feedback.textContent = "";
        fromGrid = false;
        nextFocus = null;
        void loadCatalog();
      }
    }).observe(message, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
    picker.hidden = false;
    count.textContent = "Loading items…";
    void loadCatalog();
    if (!smallScreen.matches && document.activeElement === document.body && !window.location.hash) {
      barcode.focus({ preventScroll: true });
    }

    setupMobileCart();
  }

  function setupMobileCart() {
    const dialog = byId("mobile-pos-cart");
    const panel = byId("pos-cart-panel");
    const toggle = byId("mobile-cart-open");
    const close = byId("mobile-cart-close");
    if (!dialog || typeof dialog.showModal !== "function") return;
    const originalPosition = panel.parentNode;
    const total = byId("cart-total");
    const breakdown = byId("cart-breakdown");
    const message = byId("page-message");
    const result = byId("mobile-cart-result");
    const sync = () => {
      byId("mobile-cart-count").textContent = breakdown.textContent.split(" · ")[0] || "0 units";
      byId("mobile-cart-price").textContent = total.textContent.replace(/^Total\s+/, "");
      result.className = message.className;
      result.textContent = message.textContent;
    };
    const mode = () => {
      if (!smallScreen.matches && dialog.open) dialog.close();
      document.body.classList.toggle("pos-mobile-cart", smallScreen.matches);
      toggle.hidden = !smallScreen.matches;
    };
    toggle.addEventListener("click", () => {
      if (!smallScreen.matches || dialog.open) return;
      byId("mobile-cart-content").append(panel);
      dialog.showModal();
      close.focus();
    });
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      originalPosition.append(panel);
      if (smallScreen.matches) toggle.focus({ preventScroll: true });
    });
    const observer = new MutationObserver(sync);
    observer.observe(total, { childList: true, subtree: true });
    observer.observe(breakdown, { childList: true, subtree: true });
    observer.observe(message, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    smallScreen.addEventListener("change", mode);
    sync();
    mode();
  }

  function startItems() {
    const host = byId("products-table");
    const filters = byId("item-status-chips");
    const count = byId("product-count");
    const empty = byId("mobile-item-empty");
    const details = byId("product-detail-panel");
    let byProduct = new Map();
    let active = "all";
    let lookupRevision = 0;

    function statusOf(item) {
      return {
        low: Boolean(item && (item.low_stock || Number(item.sellable_stock) === 0)),
        expiry: Boolean(item && ["watch", "expired"].includes(item.expiry_status)),
        slow: Boolean(item && item.data_status === "Enough data" && item.sold_last_28_days === 0 && item.sellable_stock > 0),
      };
    }

    function getProduct(row) {
      return byProduct.get(String(row.querySelector("[data-product-id]")?.dataset.productId));
    }

    function applyFilters() {
      host.dataset.statusFilter = active;
      const rows = Array.from(host.querySelectorAll("[data-catalog-search]"));
      let visible = 0;
      for (const row of rows) {
        const matchesStatus = active === "all" || statusOf(getProduct(row))[active];
        row.toggleAttribute("data-status-mismatch", !matchesStatus);
        if (!row.hidden && matchesStatus) visible++;
      }
      empty.hidden = active === "all" || visible > 0;
      if (active !== "all") count.textContent = "Showing " + visible + " of " + rows.length + " products";
    }

    function showEvidence() {
      const panel = byId("mobile-item-evidence");
      const item = byProduct.get(details.dataset.productId);
      if (details.hidden || !item) {
        panel.hidden = true;
        return;
      }
      const content = byId("item-evidence-content");
      const max = Math.max(1, Number(item.sold_last_28_days), Number(item.forecast_next_30_days));
      const fields = [
        { label: "Sellable stock", value: item.sellable_stock },
        { label: "Nearest expiry", value: item.nearest_expiry || "Unknown" },
        { label: "Sales · last 28 days", value: item.sold_last_28_days, bar: true },
        { label: "AI forecast · next 30 days", value: item.forecast_next_30_days, bar: true, ai: true },
      ];
      content.replaceChildren(...fields.map(({ label, value, bar, ai }) => {
        const tile = element("div", "mobile-evidence-tile" + (ai ? " mobile-evidence-ai" : ""));
        tile.append(element("small", "", label), element("strong", "", value ?? "—"));
        if (bar && value != null && Number.isFinite(Number(value))) {
          const meter = element("meter");
          meter.min = 0;
          meter.max = max;
          meter.value = Number(value);
          meter.setAttribute("aria-hidden", "true");
          tile.append(meter);
        }
        return tile;
      }));
      byId("item-forecast-link").href = "/reports.html?product_id=" + encodeURIComponent(item.product_id) + "#decision";
      panel.hidden = false;
    }

    function syncCards() {
      const table = host.querySelector("table");
      if (!table) return;
      table.setAttribute("role", "table");
      table.setAttribute("aria-label", "Product catalog");
      for (const group of table.querySelectorAll("thead, tbody")) group.setAttribute("role", "rowgroup");
      for (const heading of table.querySelectorAll("th")) heading.setAttribute("role", "columnheader");
      for (const row of table.rows) {
        row.setAttribute("role", "row");
        for (const cell of row.querySelectorAll("td")) cell.setAttribute("role", "cell");
      }
      for (const row of table.querySelectorAll("[data-catalog-search]")) {
        const item = getProduct(row);
        const cell = row.cells[5];
        cell.querySelectorAll(".mobile-stock-badge").forEach((entry) => entry.remove());
        if (!item) continue;
        const status = statusOf(item);
        if (status.low) {
          cell.append(Number(item.sellable_stock) === 0 ? badge("danger", "!", "Out of stock") : badge("warning", "!", "Low stock"));
        }
        if (status.expiry) {
          cell.append(item.expiry_status === "expired" ? badge("danger", "×", "Expired batch") : badge("warning", "◷", "Near expiry"));
        }
        if (status.slow) cell.append(badge("muted", "−", "No sales · 28 days"));
      }
      applyFilters();
      showEvidence();
    }

    async function loadStatus() {
      const revision = ++lookupRevision;
      try {
        const feed = await api("/api/ai/items");
        if (revision !== lookupRevision) return;
        byProduct = new Map(feed.items.map((item) => [String(item.product_id), item]));
        filters.hidden = false;
        syncCards();
      } catch (_) {
        // Existing search, season filters and item actions remain available.
      }
    }
    filters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-item-filter]");
      if (!button) return;
      active = button.dataset.itemFilter;
      for (const chip of filters.querySelectorAll("button")) chip.setAttribute("aria-pressed", String(chip === button));
      if (active === "all") filterProductCatalog();
      applyFilters();
    });
    byId("catalog-search").addEventListener("input", applyFilters);
    byId("catalog-season").addEventListener("change", applyFilters);
    byId("catalog-clear").addEventListener("click", () => {
      filters.querySelector('[data-item-filter="all"]').click();
    });
    new MutationObserver(() => {
      syncCards();
      void loadStatus();
    }).observe(host, { childList: true });
    new MutationObserver(showEvidence).observe(details, { attributes: true, attributeFilter: ["hidden", "data-product-id"] });
    syncCards();
    void loadStatus();
  }

  document.addEventListener("smart-stock:ready", () => {
    if (!currentUser) return;
    if (document.body.dataset.page === "sales") startPOS();
    if (document.body.dataset.page === "products") startItems();
  }, { once: true });
})();
