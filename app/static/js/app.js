let csrfValue = "";
let currentUser = null;
let specialDiscountRate = 0.20;
let refreshStockAlerts = () => {};

async function api(path, options) {
  const opts = options || {};
  const method = (opts.method || "GET").toUpperCase();
  const headers = new Headers(opts.headers || {});
  let body = opts.body;
  if (body && !(body instanceof FormData) && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  if (method !== "GET" && method !== "HEAD") {
    if (!csrfValue) await refreshCsrf();
    headers.set("X-CSRF-Token", csrfValue);
  }
  let response;
  try {
    response = await fetch(path, { method, headers, body, credentials: "same-origin" });
  } catch (cause) {
    throw new Error("Cannot reach Smart Stock. Check that the store server is running, then retry.", { cause });
  }
  let data;
  try {
    data = await response.json();
  } catch (cause) {
    if (response.ok) throw new Error("The server response was incomplete. Try again.", { cause });
  }
  if (!response.ok) {
    if (response.status === 401 && document.body.dataset.page) {
      window.location.href = "/";
    }
    const detail = Array.isArray(data?.detail) ? data.detail[0]?.msg : data?.detail;
    const error = new Error(detail || "Request failed. Check the API and database.");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function refreshCsrf() {
  const data = await api("/api/auth/csrf");
  csrfValue = data.csrf_token || "";
  return csrfValue;
}

function showMessage(target, message, kind) {
  if (!target) return;
  target.textContent = message || "";
  target.className = "notice" + (kind ? " " + kind : "");
}

function addCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
  row.appendChild(cell);
  return cell;
}

function buildTable(container, headers, dataRows) {
  container.replaceChildren();
  const table = document.createElement("table");
  table.className = "product-table";
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headers.forEach(function (label) {
    const th = document.createElement("th");
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  const tbody = document.createElement("tbody");
  if (!dataRows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = headers.length;
    cell.textContent = "No records yet.";
    row.appendChild(cell);
    tbody.appendChild(row);
  }
  dataRows.forEach(function (values) {
    const tr = document.createElement("tr");
    values.forEach(function (value) { addCell(tr, value); });
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  container.appendChild(table);
}

function makeStatus(status) {
  const badge = document.createElement("span");
  badge.className = "status-badge status-" + (status || "unknown");
  badge.textContent = status || "unknown";
  return badge;
}

async function loadProfile() {
  currentUser = await api("/api/auth/me");
  const name = document.getElementById("profile-name");
  const role = document.getElementById("profile-role");
  const avatar = document.getElementById("avatar");
  if (name) name.textContent = (currentUser.first_name + " " + currentUser.last_name).trim();
  if (role) role.textContent = currentUser.role;
  if (avatar) avatar.textContent = (currentUser.first_name || "S").slice(0, 1).toUpperCase();
  const menu = document.querySelector(".menu");
  if (menu && !menu.querySelector('[href="/daily-digest.html"]')) {
    const digest = document.createElement("a");
    digest.className = "menu-item";
    digest.href = "/daily-digest.html";
    digest.textContent = "Daily Digest";
    menu.firstElementChild.after(digest);
  }
  if (currentUser.role === "owner") {
    const lowStockLink = document.querySelector('.menu a[href="/low-stock.html"]');
    if (lowStockLink && !document.querySelector('.menu a[href$="/reorder.html"]')) {
      const orders = document.createElement("a");
      orders.className = "menu-item";
      // The static entry also works on an instance running the previous
      // backend while the updated purchasing backend is available locally.
      orders.href = "/assets/reorder.html";
      orders.textContent = "Suggested Purchase Orders";
      lowStockLink.after(orders);
    }
  }
}

function attachLogout() {
  document.querySelectorAll("[data-logout]").forEach(function (button) {
    button.addEventListener("click", async function () {
      try {
        await api("/api/auth/logout", { method: "POST" });
        window.location.href = "/";
      } catch (error) {
        alert(error.message);
      }
    });
  });
}

async function initAuthPage() {
  const config = await api("/api/public-config");
  await refreshCsrf();
  const loginForm = document.getElementById("login-form");
  const registerForm = document.getElementById("register-form");
  const message = document.getElementById("auth-message");
  document.querySelectorAll("[data-auth-tab]").forEach(function (button) {
    button.addEventListener("click", function () {
      const register = button.dataset.authTab === "register";
      loginForm.hidden = register;
      registerForm.hidden = !register;
      showMessage(message, "", "");
    });
  });

  async function fillSelect(url, select, valueKey, labelKey) {
    const list = await api(url);
    list.forEach(function (item) {
      const option = document.createElement("option");
      option.value = item[valueKey];
      option.textContent = item[labelKey];
      select.appendChild(option);
    });
  }
  if (config.self_registration_enabled) {
    document.querySelector('[data-auth-tab="register"]').hidden = false;
    try {
      await fillSelect("/api/locations/provinces", document.getElementById("province"), "prov_id", "prov_name");
      await fillSelect("/api/locations/stores", document.getElementById("store-select"), "store_id", "store_name");
    } catch (error) {
      showMessage(message, "Cannot load registration lists. " + error.message, "error");
    }
  }
  const province = document.getElementById("province");
  const municipality = document.getElementById("municipality");
  const barangay = document.getElementById("barangay");
  province.addEventListener("change", async function () {
    municipality.replaceChildren(new Option("Select municipality", ""));
    barangay.replaceChildren(new Option("Select barangay", ""));
    municipality.disabled = true;
    barangay.disabled = true;
    if (!province.value) return;
    try {
      await fillSelect("/api/locations/municipalities?province_id=" + encodeURIComponent(province.value), municipality, "mun_id", "mun_name");
      municipality.disabled = false;
    } catch (error) { showMessage(message, error.message, "error"); }
  });
  municipality.addEventListener("change", async function () {
    barangay.replaceChildren(new Option("Select barangay", ""));
    barangay.disabled = true;
    if (!municipality.value) return;
    try {
      await fillSelect("/api/locations/barangays?municipality_id=" + encodeURIComponent(municipality.value), barangay, "brgy_id", "brgy_name");
      barangay.disabled = false;
    } catch (error) { showMessage(message, error.message, "error"); }
  });
  document.querySelectorAll('input[name="store-option"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      const creating = document.querySelector('input[name="store-option"]:checked').value === "new";
      document.getElementById("existing-store-group").hidden = creating;
      document.getElementById("new-store-group").hidden = !creating;
      document.getElementById("store-select").required = !creating;
      document.getElementById("new-store-name").required = creating;
    });
  });
  loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    showMessage(message, "Signing in…", "");
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: {
          email: document.getElementById("login-email").value,
          password: document.getElementById("login-password").value
        }
      });
      window.location.href = data.next || "/dashboard.html";
    } catch (error) { showMessage(message, error.message, "error"); }
  });
  registerForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    showMessage(message, "Creating account…", "");
    const storeOption = document.querySelector('input[name="store-option"]:checked').value;
    try {
      const data = await api("/api/auth/register", {
        method: "POST",
        body: {
          first_name: document.getElementById("first-name").value,
          middle_name: document.getElementById("middle-name").value,
          suffix_name: document.getElementById("suffix-name").value,
          last_name: document.getElementById("last-name").value,
          email: document.getElementById("register-email").value,
          password: document.getElementById("register-password").value,
          confirm_password: document.getElementById("confirm-password").value,
          barangay_id: Number(barangay.value),
          store_option: storeOption,
          store_id: storeOption === "existing" ? Number(document.getElementById("store-select").value) : null,
          custom_store_name: document.getElementById("new-store-name").value
        }
      });
      const registeredEmail = document.getElementById("register-email").value;
      registerForm.reset();
      loginForm.hidden = false;
      registerForm.hidden = true;
      document.getElementById("login-email").value = registeredEmail;
      showMessage(message, data.message + " Your role is " + data.role + ".", "success");
      await refreshCsrf();
    } catch (error) { showMessage(message, error.message, "error"); }
  });
}

async function loadDashboard() {
  const summary = await api("/api/dashboard/summary");
  const count = new Intl.NumberFormat();
  document.getElementById("store-name").textContent = summary.store_name || "Store overview";
  document.getElementById("weekly-sales").textContent = count.format(summary.weekly_sales_quantity);
  document.getElementById("weekly-orders").textContent = count.format(summary.weekly_sale_lines);
  document.getElementById("products-count").textContent = count.format(summary.products_count);
  document.getElementById("stock-units").textContent = count.format(summary.stock_units);
  const chart = document.getElementById("sales-chart");
  chart.replaceChildren();
  const max = Math.max(1, ...summary.chart.map(function (d) { return d.quantity; }));
  summary.chart.forEach(function (day) {
    const col = document.createElement("div");
    col.className = "chart-column";
    const value = document.createElement("strong");
    value.textContent = day.quantity;
    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.height = Math.max(3, Math.round((day.quantity / max) * 100)) + "px";
    const label = document.createElement("span");
    label.textContent = day.label;
    col.append(value, bar, label);
    chart.appendChild(col);
  });
  const ai = await api("/api/ai/items");
  document.getElementById("model-label").textContent = ai.chronos_loaded ? "Chronos-Bolt available" : "Moving-average forecast available";
  document.getElementById("off-season-count").textContent = count.format(ai.items.filter((row) => row.sale_season === "off_season").length);
  document.getElementById("expiry-alert-count").textContent = count.format(ai.items.filter((row) => ["expired", "watch"].includes(row.expiry_status)).length);
  document.getElementById("reorder-count").textContent = count.format(ai.items.filter((row) => row.low_stock).length);
  const attention = (row) => row.expiry_status === "expired" ? 0 : row.expiry_status === "watch" ? 1 : row.low_stock ? 2 : 3;
  renderAiTable(document.getElementById("ai-table-wrap"), ai.items.sort((a, b) => attention(a) - attention(b)));
}

function renderAiTable(container, items) {
  container.replaceChildren();
  const table = document.createElement("table");
  table.className = "product-table";
  const headers = ["Product", "Selling status", "Sellable units", "Expiry", "Forecast to expiry", "Reorder"];
  const trHead = document.createElement("tr");
  headers.forEach(function (label) { const th = document.createElement("th"); th.textContent = label; trHead.appendChild(th); });
  const thead = document.createElement("thead");
  thead.appendChild(trHead);
  const tbody = document.createElement("tbody");
  if (!items.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = headers.length;
    td.textContent = "No products yet. Add a product to see monitoring.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  items.forEach(function (item) {
    const tr = document.createElement("tr");
    const product = document.createElement("td");
    const link = document.createElement("a");
    link.href = "/reports.html?product_id=" + encodeURIComponent(item.product_id) + "#decision";
    link.textContent = item.product_name;
    product.appendChild(link);
    tr.appendChild(product);
    const season = document.createElement("td");
    const seasonBadge = makeStatus(productSeasonStyles[item.sale_season]);
    seasonBadge.textContent = productSeasonLabels[item.sale_season] || "General product";
    season.appendChild(seasonBadge);
    tr.appendChild(season);
    addCell(tr, (item.sellable_stock ?? item.current_stock) + " " + item.unit);
    const expiry = document.createElement("td");
    const expiryStates = { expired: ["red", "Expired batch"], watch: ["yellow", "Review expiry"], clear: ["green", "Dated"],
      unknown: ["unknown", "Unknown"], none: ["unknown", "No stock"] };
    const [color, label] = expiryStates[item.expiry_status] || ["unknown", item.nearest_expiry || "Unknown"];
    const expiryBadge = makeStatus(color);
    expiryBadge.textContent = label;
    expiry.appendChild(expiryBadge);
    if (item.nearest_expiry && label !== item.nearest_expiry) expiry.append(" " + item.nearest_expiry);
    tr.appendChild(expiry);
    const interval = item.forecast_range_available ? " (" + item.forecast_low + "–" + item.forecast_high + ")" : "";
    addCell(tr, item.forecast_until_expiry == null ? "—" : item.forecast_until_expiry + interval);
    const lowCell = document.createElement("td");
    if (item.low_stock) {
      const badge = makeStatus("blue");
      badge.textContent = "Reorder";
      lowCell.appendChild(badge);
    } else {
      lowCell.textContent = "—";
    }
    tr.appendChild(lowCell);
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  container.appendChild(table);
}

const productSeasonLabels = {
  general: "General product",
  in_season: "In season",
  off_season: "Off-season product"
};
const productSeasonStyles = { general: "unknown", in_season: "green", off_season: "off_season" };
const productMonth = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });
const productCurrency = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

function monthName(month) {
  return productMonth.format(new Date(Date.UTC(2000, month - 1, 1)));
}

function productPriceLabel(price) {
  return price == null ? "—" : productCurrency.format(Number(price));
}

function productPlanningValues(form) {
  const values = new FormData(form);
  const start = values.get("season_start_month");
  const end = values.get("season_end_month");
  const cost = values.get("unit_cost");
  if (Boolean(start) !== Boolean(end)) {
    throw new Error("Choose both season months or leave both blank for a general product.");
  }
  return {
    projected_price: values.get("projected_price") || null,
    ...(cost === null ? {} : { unit_cost: cost || null }),
    season_start_month: start ? Number(start) : null,
    season_end_month: end ? Number(end) : null
  };
}

function showProductDetails(product) {
  const panel = document.getElementById("product-detail-panel");
  const overview = document.getElementById("product-overview");
  const maintenance = document.getElementById("product-maintenance-form");
  const startMonth = product.season_start_month;
  const endMonth = product.season_end_month;
  const hasCost = currentUser.role === "owner" && Object.hasOwn(product, "unit_cost");
  let season = "Year-round";
  if (startMonth && endMonth) {
    season = monthName(startMonth);
    if (startMonth !== endMonth) season += " – " + monthName(endMonth);
  }
  const fields = [
    ["Product ID", product.product_id],
    ["Barcode / SKU", product.product_barcode],
    ["Category", product.product_category],
    ["On hand", product.product_quantity + " " + product.product_unit],
    ["Current selling price", productPriceLabel(product.product_price)],
    ["Projected selling price", productPriceLabel(product.product_projected_price)],
    ...(hasCost ? [["Purchase cost per unit", productPriceLabel(product.unit_cost)]] : []),
    ["Seasonal window", season],
    ["Season status", productSeasonLabels[product.sale_season]],
    ["Total units sold", product.total_units_sold],
    ["Reorder level", product.reorder_level],
    ["Safety stock", product.safety_stock_units],
    ["Supplier lead time", product.supplier_lead_time_days + " days"],
    ["Nearest batch expiry", product.nearest_expiry || "Unknown"],
    ["Date added", product.product_date_added],
    ["Store", product.store_name]
  ];
  overview.replaceChildren();
  for (const [label, value] of fields) {
    const tile = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value ?? "—";
    tile.append(term, detail);
    overview.appendChild(tile);
  }
  panel.dataset.productId = product.product_id;
  document.getElementById("product-detail-name").textContent = product.product_name;
  maintenance.elements.price.value = product.product_price;
  maintenance.elements.projected_price.value = product.product_projected_price ?? "";
  if (maintenance.elements.unit_cost) {
    maintenance.elements.unit_cost.value = product.unit_cost ?? "";
    maintenance.elements.unit_cost.disabled = !hasCost;
    document.getElementById("maintenance-cost-field").hidden = !hasCost;
  }
  maintenance.elements.season_start_month.value = product.season_start_month ?? "";
  maintenance.elements.season_end_month.value = product.season_end_month ?? "";
  maintenance.hidden = currentUser.role !== "owner";
  panel.hidden = false;
}

function syncStockExpiry() {
  document.getElementById("adjust-expiry").disabled = document.getElementById("adjust-action").value === "decrease";
}

function filterProductCatalog() {
  const query = (document.getElementById("catalog-search")?.value || "").trim().toLowerCase();
  const season = document.getElementById("catalog-season")?.value || "";
  const rows = document.querySelectorAll("#products-table [data-catalog-search]");
  const empty = document.querySelector("#products-table [data-catalog-empty]");
  const clear = document.getElementById("catalog-clear");
  let visible = 0;

  rows.forEach(function (row) {
    row.hidden = !row.dataset.catalogSearch.includes(query) || Boolean(season && row.dataset.catalogSeason !== season);
    if (!row.hidden) visible++;
  });
  if (clear) clear.disabled = !query && !season;
  if (!empty) return;
  empty.hidden = visible > 0;
  empty.cells[0].textContent = rows.length ? "No products match these filters." : "No products yet.";
  const count = document.getElementById("product-count");
  count.textContent = query || season ? "Showing " + visible + " of " + rows.length + " products" :
    rows.length + (rows.length === 1 ? " product" : " products");
}

async function loadProducts() {
  const products = await api("/api/products");
  const select = document.getElementById("adjust-product");
  select.replaceChildren(new Option("Select product", ""));
  products.forEach(function (product) {
    const option = document.createElement("option");
    option.value = product.product_id;
    option.textContent = product.product_name + " (" + product.product_quantity + ")";
    select.appendChild(option);
  });
  const wrap = document.getElementById("products-table");
  const headers = ["Name", "Barcode", "Stock", "Current price", "Projected price", "Season", "Actions"];
  wrap.replaceChildren();
  const table = document.createElement("table");
  table.className = "product-table";
  const head = document.createElement("thead");
  const rowHead = document.createElement("tr");
  headers.forEach(function (name) { const th = document.createElement("th"); th.textContent = name; rowHead.appendChild(th); });
  head.appendChild(rowHead);
  const body = document.createElement("tbody");
  const empty = document.createElement("tr");
  empty.dataset.catalogEmpty = "";
  addCell(empty, "").colSpan = headers.length;
  body.appendChild(empty);
  products.forEach(function (product) {
    const tr = document.createElement("tr");
    tr.dataset.catalogSearch = ((product.product_name || "") + " " + (product.product_barcode || "")).toLowerCase();
    tr.dataset.catalogSeason = product.sale_season || "general";
    addCell(tr, product.product_name);
    addCell(tr, product.product_barcode);
    addCell(tr, product.product_quantity + " " + (product.product_unit || "pieces"));
    addCell(tr, productPriceLabel(product.product_price));
    addCell(tr, productPriceLabel(product.product_projected_price));
    const seasonBadge = makeStatus(productSeasonStyles[tr.dataset.catalogSeason]);
    seasonBadge.textContent = productSeasonLabels[tr.dataset.catalogSeason];
    addCell(tr, "").replaceChildren(seasonBadge);
    const action = document.createElement("td");
    const controls = document.createElement("div");
    controls.className = "product-controls";
    const details = document.createElement("button");
    details.type = "button";
    details.className = "btn btn-secondary";
    details.textContent = "Details";
    details.dataset.productId = product.product_id;
    details.setAttribute("aria-controls", "product-detail-panel");
    details.setAttribute("aria-label", "Details for " + product.product_name);
    details.addEventListener("click", function () {
      showMessage(document.getElementById("product-detail-message"), "");
      showProductDetails(product);
      document.getElementById("product-detail-name").focus();
    });
    controls.appendChild(details);
    [["+", "increase", "Add stock for "], ["−", "decrease", "Reduce stock for "]].forEach(function ([symbol, adjustment, label]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-secondary";
      button.textContent = symbol;
      button.setAttribute("aria-label", label + product.product_name);
      button.disabled = adjustment === "decrease" && Number(product.product_quantity) <= 0;
      button.addEventListener("click", function () {
        select.value = product.product_id;
        document.getElementById("adjust-action").value = adjustment;
        const quantity = document.getElementById("adjust-quantity");
        quantity.value = "";
        syncStockExpiry();
        quantity.focus();
      });
      controls.appendChild(button);
    });
    if (currentUser.role === "owner" && !Number(product.has_sales) && !Number(product.has_movements)) {
      const button = document.createElement("button");
      button.className = "btn btn-danger";
      button.textContent = "Delete";
      button.addEventListener("click", async function () {
        if (!confirm("Delete this product?")) return;
        try {
          await api("/api/products/" + product.product_id, { method: "DELETE" });
          refreshStockAlerts();
          await loadProducts();
        }
        catch (error) { showMessage(document.getElementById("page-message"), error.message, "error"); }
      });
      controls.appendChild(button);
    }
    action.appendChild(controls);
    tr.appendChild(action);
    body.appendChild(tr);
  });
  table.append(head, body);
  wrap.appendChild(table);
  filterProductCatalog();
  const canAddProduct = currentUser.role === "owner";
  const addCost = document.getElementById("product-cost");
  if (addCost && canAddProduct) {
    const hasCost = products.length
      ? Object.hasOwn(products[0], "unit_cost")
      : (await api("/api/public-config")).sales_performance_enabled === true;
    addCost.disabled = !hasCost;
    document.getElementById("product-cost-field").hidden = !hasCost;
  }
  document.getElementById("add-product-panel").hidden = !canAddProduct;
  const addProductLink = document.getElementById("catalog-add-product");
  if (addProductLink) addProductLink.hidden = !canAddProduct;
  const panel = document.getElementById("product-detail-panel");
  if (!panel.hidden) {
    const selected = products.find(function (product) { return String(product.product_id) === panel.dataset.productId; });
    if (selected) showProductDetails(selected);
    else panel.hidden = true;
  }
}

function initProductBarcode(form) {
  const scanButton = document.getElementById("product-barcode-scan");
  if (!scanButton) return;
  const barcode = document.getElementById("product-barcode");
  const name = document.getElementById("product-name");
  const status = document.getElementById("product-barcode-status");
  let lookupVersion = 0;

  function clearBarcodeCheck() {
    lookupVersion++;
    barcode.setCustomValidity("");
    showMessage(status, "");
  }

  barcode.addEventListener("input", clearBarcodeCheck);
  form.addEventListener("reset", clearBarcodeCheck);
  scanButton.addEventListener("click", function () {
    barcode.focus();
    barcode.select();
    showMessage(status, "Scan with Barcode to PC using Barcode + Enter, or type the code and press Enter.");
  });
  barcode.addEventListener("keydown", async function (event) {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (event.repeat) return;

    barcode.value = barcode.value.trim();
    barcode.setCustomValidity("");
    const version = ++lookupVersion;
    if (!barcode.reportValidity()) {
      showMessage(status, "");
      return;
    }

    const value = barcode.value;
    showMessage(status, "Checking barcode…");
    try {
      const product = await api("/api/products/lookup?barcode=" + encodeURIComponent(value));
      if (version !== lookupVersion) return;
      const message = "This barcode is already registered to " + product.product_name + ".";
      barcode.setCustomValidity(message);
      showMessage(status, message, "error");
    } catch (error) {
      if (version !== lookupVersion) return;
      if (error.status === 404) {
        showMessage(status, "New barcode captured. Enter the product details and save.", "success");
        if (document.activeElement === barcode) name.focus();
      } else {
        showMessage(status, "Barcode check unavailable. Press Enter to retry.", "error");
      }
    }
  });
}

function initProducts() {
  const search = document.getElementById("catalog-search");
  const season = document.getElementById("catalog-season");
  search?.addEventListener("input", filterProductCatalog);
  season?.addEventListener("change", filterProductCatalog);
  document.getElementById("catalog-clear")?.addEventListener("click", function () {
    search.value = "";
    season.value = "";
    filterProductCatalog();
    search.focus();
  });
  document.querySelectorAll("[data-season-month]").forEach(function (select) {
    for (let month = 1; month <= 12; month++) select.add(new Option(monthName(month), String(month)));
  });
  const detailPanel = document.getElementById("product-detail-panel");
  const detailMessage = document.getElementById("product-detail-message");
  document.getElementById("product-detail-close").addEventListener("click", function () {
    detailPanel.hidden = true;
    const detailsButton = document.querySelector("#products-table [data-product-id='" + detailPanel.dataset.productId + "']");
    if (detailsButton && !detailsButton.closest("tr")?.hidden) detailsButton.focus();
    else search?.focus();
  });
  document.getElementById("product-maintenance-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector("button[type='submit']");
    submit.disabled = true;
    try {
      await api("/api/products/" + detailPanel.dataset.productId + "/maintenance", {
        method: "PATCH",
        body: { price: form.elements.price.value, ...productPlanningValues(form) }
      });
      refreshStockAlerts();
      await loadProducts();
      showMessage(detailMessage, "Product details saved.", "success");
    } catch (error) {
      showMessage(detailMessage, error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
  const productForm = document.getElementById("product-form");
  const productMessage = document.getElementById("product-form-message") || document.getElementById("page-message");
  const adjustMessage = document.getElementById("adjust-stock-message") || document.getElementById("page-message");
  initProductBarcode(productForm);
  productForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    try {
      await api("/api/products", {
        method: "POST",
        body: {
          product_name: document.getElementById("product-name").value,
          product_barcode: document.getElementById("product-barcode").value,
          product_quantity: Number(document.getElementById("product-quantity").value),
          category: document.getElementById("product-category").value,
          unit: document.getElementById("product-unit").value,
          price: Number(document.getElementById("product-price").value),
          reorder_level: Number(document.getElementById("reorder-level").value),
          supplier_lead_time_days: Number(document.getElementById("lead-time").value),
          safety_stock_units: Number(document.getElementById("safety-stock").value),
          expiry_date: document.getElementById("product-expiry").value || null,
          ...productPlanningValues(productForm)
        }
      });
      productForm.reset();
      refreshStockAlerts();
      showMessage(productMessage, "Product added.", "success");
      await loadProducts();
    } catch (error) { showMessage(productMessage, error.message, "error"); }
  });
  document.getElementById("adjust-action").addEventListener("change", syncStockExpiry);
  document.getElementById("adjust-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector("button[type='submit']");
    submit.disabled = true;
    try {
      const id = document.getElementById("adjust-product").value;
      const action = document.getElementById("adjust-action").value;
      await api("/api/products/" + id + "/stock-adjustments", {
        method: "POST",
        body: {
          action: action,
          quantity: Number(document.getElementById("adjust-quantity").value),
          notes: document.getElementById("adjust-notes").value,
          expiry_date: action === "increase" ? document.getElementById("adjust-expiry").value || null : null
        }
      });
      showMessage(adjustMessage, "Stock updated.", "success");
      refreshStockAlerts();
      form.reset();
      syncStockExpiry();
      await loadProducts();
    } catch (error) { showMessage(adjustMessage, error.message, "error"); }
    finally { submit.disabled = false; }
  });
}

function saleTypeLabel(type) {
  return type === "seasonal" ? "Seasonal" : "General";
}

function paintCart(cart, locked, removeLine) {
  const wrap = document.getElementById("cart-table");
  wrap.replaceChildren();
  const table = document.createElement("table");
  table.className = "product-table";
  const head = document.createElement("thead");
  const hrow = document.createElement("tr");
  ["Product", "Qty", "Unit price", "Subtotal", "Action"].forEach(function (label) {
    const th = document.createElement("th"); th.textContent = label; hrow.appendChild(th);
  });
  head.appendChild(hrow);
  const body = document.createElement("tbody");
  let subtotalCents = 0;
  let totalUnits = 0;
  cart.forEach(function (line, index) {
    const tr = document.createElement("tr");
    const product = document.createElement("td");
    const name = document.createElement("strong");
    const details = document.createElement("small");
    name.textContent = line.product.product_name;
    details.textContent = line.product.product_barcode + " · " + saleTypeLabel(line.product.sale_type);
    details.className = "muted-text";
    product.append(name, details);
    tr.appendChild(product);
    addCell(tr, line.quantity);
    const priceCents = Math.round(Number(line.product.product_price || 0) * 100);
    const lineTotalCents = priceCents * line.quantity;
    subtotalCents += lineTotalCents;
    totalUnits += line.quantity;
    addCell(tr, "₱" + (priceCents / 100).toFixed(2));
    addCell(tr, "₱" + (lineTotalCents / 100).toFixed(2));
    const td = document.createElement("td");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn btn-danger cart-remove"; remove.textContent = "Remove";
    remove.disabled = Boolean(locked);
    remove.addEventListener("click", function () { removeLine(index); });
    td.appendChild(remove); tr.appendChild(td); body.appendChild(tr);
  });
  if (!cart.length) {
    const tr = document.createElement("tr"); const td = document.createElement("td");
    td.colSpan = 5; td.textContent = "Cart is empty."; tr.appendChild(td); body.appendChild(tr);
  }
  table.append(head, body); wrap.appendChild(table);
  const discountType = document.getElementById("discount-type").value;
  const discountCents = discountType === "none" ? 0 : Math.round(subtotalCents * specialDiscountRate);
  document.getElementById("cart-breakdown").textContent = totalUnits + " units · Subtotal ₱" +
    (subtotalCents / 100).toFixed(2) + " · Discount ₱" + (discountCents / 100).toFixed(2);
  document.getElementById("cart-total").textContent = "Total ₱" + ((subtotalCents - discountCents) / 100).toFixed(2);
}

function newCheckoutId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

async function loadSalesPage() {
  const discountConfig = await api("/api/public-config");
  specialDiscountRate = Number(discountConfig.special_discount_rate || 0);
  document.querySelector(".small-note").textContent =
    "Special discount rate: " + (specialDiscountRate * 100).toFixed(0) +
    "%. Confirm the store's required discount and tax policy before real transactions.";
  const barcode = document.getElementById("sale-barcode");
  const quantityField = document.getElementById("sale-quantity");
  const scannerAppStart = document.getElementById("scanner-app-start");
  const scannerAppGuide = document.getElementById("scanner-app-guide");
  const preview = document.getElementById("scan-preview");
  const addItem = document.getElementById("add-cart-item");
  const complete = document.getElementById("complete-sale");
  const discount = document.getElementById("discount-type");
  const reference = document.getElementById("discount-reference");
  const message = document.getElementById("page-message");
  let cart = [];
  let pending = null;
  let sending = false;
  let lookingUp = false;
  const scannerOptions = {
    isCheckoutLocked: function () { return Boolean(pending); },
    isAdding: function () { return lookingUp; },
    addBarcode: addBarcodeToCart
  };
  const pcScanner = typeof initPosCameraScanner === "function" ? initPosCameraScanner(scannerOptions) : null;

  function updateControls() {
    const locked = Boolean(pending);
    barcode.disabled = locked;
    quantityField.disabled = locked;
    scannerAppStart.disabled = locked || lookingUp;
    discount.disabled = locked;
    reference.disabled = locked;
    addItem.disabled = locked || lookingUp;
    complete.disabled = sending || lookingUp || !cart.length;
    complete.textContent = sending ? "Recording sale…" : locked ? "Retry checkout" : "Complete sale";
    pcScanner?.update();
    paintCart(cart, locked, function (index) {
      cart.splice(index, 1);
      updateControls();
    });
  }

  async function addBarcodeToCart(value, quantity, isCurrent = function () { return true; }) {
    if (pending || lookingUp) return null;
    lookingUp = true;
    updateControls();
    try {
      const product = await api("/api/products/lookup?barcode=" + encodeURIComponent(value));
      if (!isCurrent()) return null;
      const found = cart.find(function (line) { return line.product.product_id === product.product_id; });
      const inCart = found ? found.quantity : 0;
      const stock = Number(product.sellable_quantity);
      if (quantity + inCart > stock || quantity + inCart > 10000) {
        const available = Math.max(0, Math.min(stock, 10000) - inCart);
        return { success: false, message: "You can add up to " + available + " more units of " + product.product_name + "." };
      }
      if (!found && cart.length >= 100) {
        return { success: false, message: "This checkout can contain up to 100 different products." };
      }
      if (found) {
        found.quantity += quantity;
        found.product = product;
      } else {
        cart.push({ product: product, quantity: quantity });
      }
      const seasonal = product.sale_type === "seasonal" ? "In season" :
        product.season_start_month == null ? "General product" : "Off-season product";
      return {
        success: true,
        message: [product.product_name, product.product_category, seasonal,
          stock + " " + (product.product_unit || "units") + " available for sale",
          "₱" + Number(product.product_price || 0).toFixed(2)].join(" · ")
      };
    } catch (error) {
      if (!isCurrent()) return null;
      return {
        success: false, message: error.message,
        retryable: !error.status || error.status === 408 || error.status === 429 || error.status >= 500
      };
    } finally {
      lookingUp = false;
      updateControls();
    }
  }

  addItem.addEventListener("click", async function () {
    const value = barcode.value.trim();
    const quantity = quantityField.valueAsNumber;
    if (!value) {
      showMessage(preview, "Scan a barcode or enter it manually.", "error");
      barcode.focus();
      return;
    }
    if (!Number.isInteger(quantity) || !quantityField.checkValidity()) {
      showMessage(preview, "Enter a whole quantity from 1 to 10,000.", "error");
      return;
    }
    const outcome = await addBarcodeToCart(value, quantity);
    if (!outcome) return;
    showMessage(preview, outcome.message, outcome.success ? "success" : "error");
    if (outcome.success) {
      if (barcode.value.trim() === value) barcode.value = "";
      if (quantityField.valueAsNumber === quantity) quantityField.value = "1";
    }
    barcode.focus();
  });
  scannerAppStart.addEventListener("click", function () {
    scannerAppGuide.hidden = false;
    scannerAppStart.setAttribute("aria-expanded", "true");
    quantityField.value = "1";
    barcode.focus();
    barcode.select();
  });
  barcode.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      addItem.click();
    }
  });
  discount.addEventListener("change", updateControls);
  complete.addEventListener("click", async function () {
    const retrying = Boolean(pending);
    if (!retrying) {
      if (!confirm("Has checkout been completed? Record this sale?")) return;
      pending = {
        checkout_id: newCheckoutId(),
        items: cart.map(function (line) { return { product_id: line.product.product_id, quantity: line.quantity }; }),
        discount_type: discount.value,
        discount_reference: reference.value
      };
      pcScanner?.pauseForCheckout();
    }
    sending = true;
    updateControls();
    try {
      const result = await api("/api/sales", { method: "POST", body: pending });
      if (!result.transaction_id) throw new Error("Checkout confirmation was unavailable.");
      pending = null;
      cart = [];
      preview.textContent = "Scan a barcode or type it and press Enter.";
      preview.className = "muted-text";
      reference.value = "";
      discount.value = "none";
      showMessage(message, result.message + " Receipt #" + result.transaction_id + " · Total ₱" + Number(result.total).toFixed(2), "success");
      refreshStockAlerts();
      loadSalesHistory();
      loadSalesOverview();
    } catch (error) {
      const checkoutRejected = [400, 404, 409, 422].includes(error.status);
      const firstAttemptRejected = !retrying && error.status >= 400 && error.status < 500 && error.status !== 408;
      if (checkoutRejected || firstAttemptRejected) {
        pending = null;
        showMessage(message, error.message, "error");
      } else {
        showMessage(message, "Checkout could not be confirmed. Keep this tab open and choose Retry checkout when the connection returns.", "error");
      }
    } finally {
      sending = false;
      updateControls();
      if (!pending) barcode.focus();
    }
  });
  document.getElementById("sales-filter-form").addEventListener("submit", function (event) {
    event.preventDefault();
    loadSalesHistory();
  });
  updateControls();
  await Promise.all([loadSalesHistory(), loadSalesOverview()]);
}

async function loadSalesOverview() {
  const [ai, bestSellers] = await Promise.allSettled([api("/api/ai/items"), api("/api/sales/best-sellers")]);
  const modelLabel = document.getElementById("sales-model-label");
  if (ai.status === "fulfilled") {
    modelLabel.textContent = ai.value.chronos_loaded ? "Chronos-Bolt" : "Moving-average fallback";
    renderAiTable(document.getElementById("sales-ai-table"), ai.value.items);
  } else {
    modelLabel.textContent = "Product monitoring unavailable.";
  }
  const bestSellersTable = document.getElementById("best-sellers");
  if (bestSellers.status === "fulfilled") {
    buildTable(bestSellersTable, ["Product", "Barcode", "Sold"],
      bestSellers.value.map(function (item) { return [item.product_name, item.product_barcode, item.sold_last_30_days]; }));
  } else {
    bestSellersTable.textContent = "Best sellers unavailable.";
  }
}

let salesHistoryRequest = 0;
async function loadSalesHistory() {
  const request = ++salesHistoryRequest;
  const params = new URLSearchParams({ limit: "100" });
  const type = document.getElementById("sales-type-filter").value;
  const from = document.getElementById("sales-date-from").value;
  const to = document.getElementById("sales-date-to").value;
  const message = document.getElementById("sales-history-message");
  const table = document.getElementById("recent-sales");
  if (type) params.set("sale_type", type);
  if (from) params.set("date_from", from);
  if (to) params.set("date_to", to);
  try {
    const sales = await api("/api/sales?" + params);
    if (request !== salesHistoryRequest) return;
    showMessage(message, sales.length === 100 ? "Showing the latest 100 matching items." : "", "");
    buildTable(table, ["Date & time", "Source", "Receipt", "Product", "Barcode", "Sale type", "Quantity", "Unit price", "Line total"], sales.map(function (item) {
      const source = {pos: "POS checkout", historical_import: "Imported history", history: "Imported history", legacy: "Legacy record"}[item.sale_source];
      return [item.sale_date, source, item.sale_transaction_id, item.product_name, item.product_barcode,
        saleTypeLabel(item.sale_type), item.sale_quantity,
        item.sale_source === "history" || item.sale_source === "historical_import" ? null : "₱" + Number(item.sale_unit_price).toFixed(2),
        item.sale_source === "history" || item.sale_source === "historical_import" ? null : "₱" + Number(item.line_total).toFixed(2)];
    }));
  } catch (error) {
    if (request !== salesHistoryRequest) return;
    table.replaceChildren();
    showMessage(message, error.message, "error");
  }
}

let historyPage = 1;
async function loadHistory() {
  const params = new URLSearchParams({ page: String(historyPage), page_size: "25" });
  const type = document.getElementById("history-type").value;
  const from = document.getElementById("history-from").value;
  const to = document.getElementById("history-to").value;
  if (type) params.set("movement_type", type);
  if (from) params.set("date_from", from);
  if (to) params.set("date_to", to);
  const movements = await api("/api/stock/movements?" + params.toString());
  document.getElementById("movement-count").textContent = movements.total + " records";
  document.getElementById("history-page").textContent = "Page " + movements.page;
  buildTable(document.getElementById("movement-table"),
    ["Date & time", "Product", "Change", "Qty", "Before", "After", "Recorded by", "Notes"],
    movements.items.map(function (m) {
      return [m.movement_date, m.product_name, m.movement_type, m.quantity, m.previous_quantity, m.new_quantity,
        ((m.users_fname || "") + " " + (m.users_lname || "")).trim(), m.notes];
    })
  );
  const stock = await api("/api/stock");
  buildTable(document.getElementById("current-stock"), ["Product", "Barcode", "On hand", "Nearest expiry"],
    stock.map(function (p) { return [p.product_name, p.product_barcode, p.current_stock, p.nearest_expiry]; }));
  document.getElementById("history-prev").disabled = historyPage <= 1;
  document.getElementById("history-next").disabled = historyPage * 25 >= movements.total;
}

function stockAlertPriority(item) {
  if (item.sale_season === "off_season") return 1;
  return Number(item.sellable_stock) === 0 ? 0 : 2;
}

const stockAlertLabels = ["No sellable stock", "Seasonal order due", "Reorder point"];

function stockAlertNode(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent) node.textContent = textContent;
  return node;
}

function stockAlertLink(item, label) {
  const link = stockAlertNode("a", "", label);
  link.href = "/reports.html?product_id=" + encodeURIComponent(item.product_id) + "#decision";
  return link;
}

function renderLowStock(data, alerts) {
  const summary = document.getElementById("low-stock-summary");
  const list = document.getElementById("low-stock-list");
  const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const quantity = (value) => value == null ? "—" : format.format(value);
  document.getElementById("low-stock-model").textContent = data.chronos_loaded ? "Chronos-Bolt and stock rules" : "Moving-average forecast and stock rules";
  showMessage(document.getElementById("page-message"), alerts.length ? "" : "No products currently need a reorder review.");
  summary.replaceChildren(...[
    ["Active alerts", alerts.length],
    [stockAlertLabels[0], alerts.filter((item) => stockAlertPriority(item) === 0).length],
    [stockAlertLabels[1], alerts.filter((item) => stockAlertPriority(item) === 1).length],
  ].map(([label, count]) => {
    const card = stockAlertNode("div", "stock-alert-stat");
    card.append(stockAlertNode("strong", "", quantity(count)), stockAlertNode("span", "", label));
    return card;
  }));
  summary.hidden = false;
  list.replaceChildren(...alerts.map((item) => {
    const priority = stockAlertPriority(item);
    const seasonal = item.seasonal_evidence;
    const card = stockAlertNode("li", "stock-alert-card");
    card.dataset.priority = String(priority);
    const header = stockAlertNode("div", "stock-alert-card-heading");
    const title = stockAlertNode("h4", "");
    title.append(stockAlertLink(item, item.product_name));
    header.append(title, stockAlertNode("span", "stock-alert-label", stockAlertLabels[priority]));
    const metric = priority === 1
      ? `Usable through opening: ${quantity(seasonal?.units_usable_through_opening)} ${item.unit} · Order by ${seasonal?.order_by || "—"}`
      : `Sellable stock: ${quantity(item.sellable_stock)} ${item.unit} · Reorder at ${quantity(item.low_stock_threshold)}`;
    card.append(header, stockAlertNode("p", "muted-text", metric),
      stockAlertNode("p", "stock-alert-action", item.low_stock_action));
    if (item.expiry_status === "expired") card.append(stockAlertNode("p", "stock-alert-expiry", item.expiry_action));
    return card;
  }));
}

function initStockAlerts(page) {
  const top = document.querySelector(".topbar-actions");
  if (!top) return;
  const host = stockAlertNode("div", "stock-alert-control");
  const toggle = stockAlertNode("button", "stock-alert-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "stock-alert-popover");
  toggle.setAttribute("aria-label", "Low stock notifications");
  const bell = stockAlertNode("span", "", "🔔");
  bell.setAttribute("aria-hidden", "true");
  const count = stockAlertNode("span", "stock-alert-count");
  count.hidden = true;
  toggle.append(bell, count);
  const panel = stockAlertNode("section", "stock-alert-popover");
  panel.id = "stock-alert-popover";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Low stock notifications");
  const heading = stockAlertNode("h3", "", "Low stock alerts");
  const status = stockAlertNode("p", "muted-text", "Checking stock…");
  const items = stockAlertNode("ul", "stock-alert-popover-list");
  const openPage = stockAlertNode("a", "stock-alert-open", "View all low stock alerts");
  openPage.href = "/low-stock.html";
  panel.append(heading, status, items, openPage);
  host.append(toggle, panel);
  top.prepend(host);

  function openPanel(open) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  }
  toggle.addEventListener("click", () => openPanel(panel.hidden));
  document.addEventListener("click", (event) => {
    if (!host.contains(event.target)) openPanel(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) { openPanel(false); toggle.focus(); }
  });

  const toast = stockAlertNode("aside", "stock-alert-toast");
  toast.hidden = true;
  const announcement = stockAlertNode("p", "stock-alert-action");
  announcement.setAttribute("role", "status");
  const view = stockAlertNode("a", "", "Review alerts");
  view.href = openPage.href;
  const dismiss = stockAlertNode("button", "btn btn-tertiary", "Dismiss");
  dismiss.type = "button";
  dismiss.addEventListener("click", () => { toast.hidden = true; toggle.focus({ preventScroll: true }); });
  toast.append(announcement, view, dismiss);
  document.body.append(toast);

  const storageKey = `smart-stock-alerts:${currentUser.store_id}:${currentUser.user_id}`;
  let previous = new Set();
  let announced = null;
  let fetching = false;
  try { previous = new Set(JSON.parse(sessionStorage.getItem(storageKey) || "[]")); } catch (_) {}

  const refresh = document.getElementById("low-stock-refresh");
  async function update() {
    if (fetching || document.hidden) return;
    fetching = true;
    if (refresh) refresh.disabled = true;
    try {
      const data = await api("/api/ai/items?status=blue");
      const alerts = [...data.items].sort((a, b) => stockAlertPriority(a) - stockAlertPriority(b)
        || a.product_name.localeCompare(b.product_name));
      const alertKey = (item) => `${item.product_id}:${stockAlertPriority(item)}`;
      const fresh = alerts.filter((item) => !previous.has(alertKey(item)));
      previous = new Set(alerts.map(alertKey));
      try { sessionStorage.setItem(storageKey, JSON.stringify([...previous])); } catch (_) {}

      const total = alerts.length;
      count.textContent = total > 99 ? "99+" : String(total);
      count.hidden = total === 0;
      toggle.setAttribute("aria-label", `Low stock notifications (${total} active)`);
      status.textContent = total ? `${total} active · ${Math.min(total, 4)} shown` : "No active reorder alerts.";
      items.replaceChildren(...alerts.slice(0, 4).map((item) => {
        const row = stockAlertNode("li", "");
        row.append(stockAlertLink(item, item.product_name), stockAlertNode("p", "muted-text", item.low_stock_action));
        return row;
      }));
      if (page === "low-stock") renderLowStock(data, alerts);
      if (fresh.length) {
        announced = alertKey(fresh[0]);
        toast.hidden = false;
        announcement.textContent = `${fresh.length} new stock ${fresh.length === 1 ? "alert" : "alerts"}. ${fresh[0].product_name}: ${stockAlertLabels[stockAlertPriority(fresh[0])]}.`;
      } else if (!previous.has(announced)) {
        toast.hidden = true;
      }
    } catch (_) {
      status.textContent = "Stock alerts could not refresh. Check the store connection.";
      if (page === "low-stock") showMessage(document.getElementById("page-message"), status.textContent, "error");
    } finally {
      fetching = false;
      if (refresh) refresh.disabled = false;
    }
  }

  refresh?.addEventListener("click", update);
  document.addEventListener("visibilitychange", update);
  setInterval(update, 60000);
  refreshStockAlerts = update;
  return update();
}

async function loadUsers() {
  try {
    const users = await api("/api/users");
    document.getElementById("users-message").textContent = "";
    buildTable(document.getElementById("users-table"), ["ID", "Name", "Email", "Role"],
      users.map(function (u) { return [u.users_id, (u.users_fname || "") + " " + (u.users_lname || ""), u.cre_username, u.users_role]; }));
  } catch (error) {
    showMessage(document.getElementById("users-message"), error.message, "error");
  }
}

function initAssistant() {
  const form = document.getElementById("assistant-form");
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const answer = document.getElementById("assistant-answer");
    answer.textContent = "Checking current inventory…";
    try {
      const result = await api("/api/assistant/ask", {
        method: "POST",
        body: { question: document.getElementById("assistant-question").value }
      });
      answer.textContent = result.answer;
      document.getElementById("assistant-data").textContent = JSON.stringify(result.data_used, null, 2);
      const provider = document.getElementById("assistant-provider");
      provider.textContent = result.provider === "groq" ? "Groq" : result.provider === "ollama" ? "Ollama" : "Local assistant";
      provider.hidden = false;
      document.getElementById("assistant-source").hidden = false;
    } catch (error) { answer.textContent = error.message; }
  });
}

async function initAppPage(page) {
  await refreshCsrf();
  try { await loadProfile(); }
  catch (_) { window.location.href = "/"; return; }
  attachLogout();
  const alerts = initStockAlerts(page);
  if (page === "dashboard") { initAssistant(); await loadDashboard(); }
  if (page === "products") { initProducts(); await loadProducts(); }
  if (page === "sales") { await loadSalesPage(); }
  if (page === "stock-history") {
    document.getElementById("history-filter").addEventListener("submit", function (event) { event.preventDefault(); historyPage = 1; loadHistory(); });
    document.getElementById("history-prev").addEventListener("click", function () { historyPage = Math.max(1, historyPage - 1); loadHistory(); });
    document.getElementById("history-next").addEventListener("click", function () { historyPage += 1; loadHistory(); });
    await loadHistory();
  }
  if (page === "low-stock") await alerts;
  if (page === "reports") await loadReports();
  if (page === "users") await loadUsers();
  if (page === "reorder") await initReorder();
  if (page === "daily-digest") await initDefenseTrial();
}

document.addEventListener("DOMContentLoaded", function () {
  const page = document.body.dataset.page;
  if (page) initAppPage(page).catch(function (error) {
    const message = document.getElementById("page-message");
    if (message) showMessage(message, error.message, "error");
    else console.error(error);
  }).finally(function () {
    document.dispatchEvent(new Event("smart-stock:ready"));
  });
  else initAuthPage().catch(function (error) {
    showMessage(document.getElementById("auth-message"), error.message, "error");
  });
});
