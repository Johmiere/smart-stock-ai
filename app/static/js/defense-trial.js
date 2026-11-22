"use strict";

async function initDefenseTrial() {
  const get = (id) => document.getElementById(id);
  const money = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
  const amount = (value) => money.format(value);
  const textNode = (tag, content) => {
    const element = document.createElement(tag);
    element.textContent = content;
    return element;
  };
  const link = (data) => {
    const element = textNode("a", data.label);
    element.href = data.href;
    return element;
  };
  let result;
  const keys = ["policy", "sku", "stockout_days", "unmet_units", "expired_units", "waste_cost", "holding_cost", "missed_margin", "total_cost", "wape"];

  async function simulate() {
    const message = get("simulation-message");
    const exportButton = get("simulation-export");
    exportButton.disabled = true;
    showMessage(message, "Running simulation…");
    try {
      result = await api("/api/defense/backtest?promo_pct=" + encodeURIComponent(get("promo").value));
      const change = result.modeled_savings;
      get("simulation-impact").textContent = change >= 0
        ? amount(change) + " lower modeled cost with adaptive reorder."
        : amount(-change) + " higher modeled cost with adaptive reorder.";
      get("digest-peso-value").textContent = amount(Math.abs(change));
      get("digest-peso-note").textContent = change >= 0 ? "Lower modeled cost · synthetic data" : "Higher modeled cost · synthetic data";
      get("digest-peso-brief").hidden = false;
      buildTable(get("simulation-totals"), ["Policy", "SKU-days with stockouts", "Missed units", "Expired units",
        "Waste cost", "Holding cost", "Missed margin", "Modeled cost"],
        Object.entries(result.totals).map(([policy, row]) => [policy, row.stockout_days, row.unmet_units, row.expired_units,
          amount(row.waste_cost), amount(row.holding_cost), amount(row.missed_margin), amount(row.total_cost)]));
      buildTable(get("simulation-skus"), ["Policy", "SKU", "Stockout days", "Missed units", "Expired units", "Waste cost",
        "Holding cost", "Missed margin", "Modeled cost", "WAPE (%)"],
        result.rows.map((row) => keys.map((key) => row[key])));
      get("simulation-data").textContent = result.sku_count + " synthetic SKUs · " + result.training_days +
        " training days per SKU · " + result.test_days + " test days per SKU · " + result.training_censored_days +
        " censored SKU-days · " + result.training_zero_sales_days + " zero-sales SKU-days in training. " +
        "Modeled cost combines expiry, ₱0.08 holding per unit-day, and missed contribution margin.";
      exportButton.disabled = false;
      showMessage(message, "");
    } catch (error) {
      showMessage(message, error.message, "error");
    }
  }

  get("defense-promo").addEventListener("submit", async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try { await simulate(); } finally { event.submitter.disabled = false; }
  });
  get("simulation-export").addEventListener("click", () => {
    const columns = ["seed", "promo_pct", ...keys];
    const quote = (value) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
    const csv = [columns.join(","), ...result.rows.map((r) => columns.map((key) => quote({
      seed: result.seed, promo_pct: result.promo_pct, ...r
    }[key])).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const download = document.createElement("a");
    download.href = url;
    download.download = "smart-stock-synthetic-backtest.csv";
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  get("defense-ask").addEventListener("submit", async (event) => {
    event.preventDefault();
    const answer = get("defense-answer");
    showMessage(answer, "Checking store records…");
    get("defense-sources").replaceChildren();
    get("defense-latency").textContent = "";
    event.submitter.disabled = true;
    try {
      const optIn = get("defense-use-groq");
      const useGroq = !get("defense-groq-option").hidden && optIn.checked;
      optIn.checked = false;
      const r = await api("/api/defense/ask", {
        method: "POST", body: { question: get("defense-question").value, use_groq: useGroq }
      });
      answer.textContent = r.sources.length
        ? r.answer
        : "I couldn't find a matching record. Try asking about stock, expiry, or reorders, or include the exact SKU.";
      get("defense-latency").textContent = r.provider + " · " + r.tool + " · " + r.latency_ms + " ms";
      get("defense-sources").replaceChildren(...r.sources.map((reference) => {
        const item = document.createElement("li");
        item.append(link(reference));
        return item;
      }));
    } catch (error) {
      showMessage(answer, error.message, "error");
    } finally {
      event.submitter.disabled = false;
    }
  });
  document.querySelectorAll("[data-assistant-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      const question = get("defense-question");
      question.value = button.dataset.assistantPrompt;
      question.focus();
    });
  });

  const summaries = Promise.allSettled([
    api("/api/dashboard/summary"),
    api("/api/ai/items"),
    currentUser.role === "owner" ? api("/api/sales/performance") : null,
  ]).then(([dashboard, ai, results]) => {
    if (dashboard.status === "fulfilled") {
      const chart = dashboard.value.chart;
      const denominator = Math.max(1, ...chart.map((point) => point.quantity));
      get("digest-sales-bars").replaceChildren(...chart.map((point) => {
        const column = document.createElement("li");
        const bar = textNode("span", "");
        bar.className = "digest-sales-bar";
        bar.style.height = String(Math.max(3, Math.round(83 * point.quantity / denominator))) + "px";
        bar.setAttribute("aria-hidden", "true");
        const label = new Date(point.date + "T00:00:00").toLocaleDateString("en-PH", {weekday: "short"});
        column.setAttribute("aria-label", point.label + ": " + point.quantity + " units");
        column.append(textNode("strong", point.quantity), bar, textNode("span", label));
        return column;
      }));
    } else {
      get("digest-sales-bars").append(textNode("li", "Sales chart unavailable."));
    }
    if (ai.status === "fulfilled") {
      get("digest-low-count").textContent = ai.value.items.filter((row) => row.low_stock).length;
      get("digest-expiry-count").textContent = ai.value.items.filter((row) => row.expiry_status === "watch").length;
    }
    if (results.status === "fulfilled" && results.value) {
      document.querySelectorAll(".digest-owner-stat").forEach((card) => { card.hidden = false; });
      get("digest-net-sales").textContent = amount(results.value.current.revenue);
      const profit = results.value.current.gross_profit;
      get("digest-gross-profit").textContent = profit == null ? "Costs needed" : amount(profit);
    }
  });

  const data = await api("/api/defense/digest");
  get("defense-groq-option").hidden = !data.groq_available;
  get("digest-meta").textContent = data.store_name + " · " + data.date + " · Synthetic trial data";
  get("digest-greeting").textContent = currentUser.first_name ? "Welcome, " + currentUser.first_name + "!" : "Welcome!";
  get("digest-date").textContent = new Date(data.date + "T00:00:00").toLocaleDateString("en-PH", {weekday: "long", month: "short", day: "numeric"});
  get("digest-store-caption").textContent = data.store_name + " · " + data.catalog_size + " products";
  const list = get("digest-actions");
  if (!data.actions.length) {
    const empty = textNode("li", "No urgent inventory tasks today.");
    empty.className = "digest-no-records";
    list.append(empty);
  }
  const actionLabels = {
    "Reconcile stock count": ["↔", "Check stock count", "Open history"],
    "Separate expired stock": ["!", "Separate expired stock", "Open history"],
    "Review stockout": ["↓", "Out of stock", "Review orders"],
    "Review a markdown or faster sell-through": ["◷", "Expiring soon", "Open history"],
    "Review reorder": ["+", "Review reorder", "Review orders"],
  };
  data.actions.forEach((item) => {
    const row = document.createElement("li");
    row.className = "stock-alert-card digest-action";
    const [symbol, title, label] = actionLabels[item.action] || ["!", item.action, "View record"];
    const visual = textNode("span", symbol);
    visual.className = "digest-action-icon";
    visual.setAttribute("aria-hidden", "true");
    const heading = document.createElement("div");
    heading.className = "digest-action-title";
    const description = document.createElement("div");
    description.append(textNode("strong", title), textNode("p", item.name));
    heading.append(visual, description);
    const action = link({ label, href: item.source.href });
    action.className = "btn btn-secondary";
    action.title = item.source.label;
    row.append(heading, textNode("p", item.reason), action);
    list.append(row);
  });
  if (currentUser.role === "owner") {
    get("defense-simulation").hidden = false;
    const profile = api("/api/defense/data-profile").then((coverage) => {
      get("defense-profile").hidden = false;
      get("defense-profile-note").textContent = coverage.start + " to " + coverage.end +
        " · ABC uses recorded units at current selling price. XYZ uses observed variability. " +
        "A zero-sales day can mean low demand, a stockout, or a missing record.";
      buildTable(get("defense-profile-table"), ["SKU", "Product", "ABC", "XYZ", "Days", "Zero-sales days", "Recorded units", "Sales value proxy", "Forecast review"],
        coverage.rows.map((r) => [r.sku, r.name, r.abc, r.xyz, r.days, r.zero_days, r.units, amount(r.value_proxy), r.profile]));
    });
    await Promise.all([simulate(), profile, summaries]);
  } else {
    await summaries;
  }
}
