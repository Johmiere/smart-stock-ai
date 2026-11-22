"use strict";

document.addEventListener("smart-stock:ready", () => {
  const byId = (id) => document.getElementById(id);
  const filters = byId("mobile-alert-filters");
  if (!filters || !currentUser) return;
  const controls = [...filters.querySelectorAll("button[data-alert-filter]")];
  const reorderList = byId("low-stock-list");
  const forecastList = byId("mobile-forecast-alerts");
  const forecastMessage = byId("mobile-forecast-message");
  const reorderMessage = byId("page-message");
  const units = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 });
  let filter = "reorder";
  let facts;
  let pending;

  function filterReorders() {
    const stockoutsOnly = filter === "stockout";
    const rows = [...reorderList.children];
    rows.forEach((row) => { row.hidden = stockoutsOnly && row.dataset.priority !== "0"; });
    byId("mobile-alert-filter-empty").hidden = !stockoutsOnly || !rows.length || rows.some((row) => !row.hidden);
    reorderMessage.hidden = stockoutsOnly && rows.length > 0 && !reorderMessage.classList.contains("error");
  }

  function textNode(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function createForecastCard(item) {
    const expired = item.expiry_status === "expired";
    const excess = filter === "excess";
    const label = excess ? "Projected excess" : expired ? "Expired batch" : "Near expiry";
    const card = document.createElement("li");
    card.className = "stock-alert-card";
    card.dataset.kind = excess ? "excess" : expired ? "expired" : "expiry";
    const header = document.createElement("div");
    header.className = "stock-alert-card-heading";
    const link = textNode("a", item.product_name);
    link.href = "/reports.html?product_id=" + encodeURIComponent(item.product_id) + "#decision";
    const name = document.createElement("h4");
    name.appendChild(link);
    header.append(name, textNode("span", label, "stock-alert-label"));
    const date = item.nearest_expiry || "Date unavailable";
    const metric = excess ? units.format(item.unsold_at_expiry) + " projected unsold at expiry · " + date
      : "Batch expiry · " + date;
    card.append(header, textNode("p", metric, "muted-text"),
      textNode("p", (excess ? item.suggested_action : item.expiry_action) || "", "stock-alert-action"));
    return card;
  }

  async function showForecast() {
    if (!facts) {
      forecastList.replaceChildren();
      showMessage(forecastMessage, "Checking forecast and batch records…");
      try {
        pending ??= api("/api/ai/items").then((data) => data.items).finally(() => { pending = null; });
        facts = await pending;
      } catch (error) {
        if (filter === "expiry" || filter === "excess") {
          showMessage(forecastMessage, error.message, "error");
        }
        return;
      }
    }
    if (filter !== "expiry" && filter !== "excess") return;
    const expiryRisk = filter === "expiry";
    const alerts = facts.filter((item) => expiryRisk
      ? item.expiry_status === "expired" || item.expiry_status === "watch"
      : item.expiry_status !== "expired" && item.sale_season !== "off_season" && Number(item.unsold_at_expiry) > 0);
    alerts.sort(expiryRisk
      ? (a, b) => Number(b.expiry_status === "expired") - Number(a.expiry_status === "expired")
        || String(a.nearest_expiry).localeCompare(String(b.nearest_expiry))
      : (a, b) => b.unsold_at_expiry - a.unsold_at_expiry);
    forecastList.replaceChildren(...alerts.map(createForecastCard));
    showMessage(forecastMessage, alerts.length ? "" : (expiryRisk
      ? "No current batches have expired or are nearing expiry."
      : "No items with enough forecast data show a risk of excess stock."));
  }

  controls.forEach((button) => button.addEventListener("click", () => {
    filter = button.dataset.alertFilter;
    controls.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    const reorder = filter === "reorder" || filter === "stockout";
    byId("mobile-reorder-feed").hidden = !reorder;
    byId("mobile-forecast-feed").hidden = reorder;
    if (reorder) filterReorders();
    else void showForecast();
  }));
  byId("low-stock-refresh").addEventListener("click", () => {
    facts = undefined;
    if (filter === "expiry" || filter === "excess") void showForecast();
  });
  new MutationObserver(filterReorders).observe(reorderList, { childList: true });
  filters.hidden = false;
  filterReorders();
}, { once: true });
