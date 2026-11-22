"use strict";

async function loadSalesPerformance() {
  const byId = (id) => document.getElementById("sales-performance" + id);
  const panel = byId("");
  if (!panel || currentUser.role !== "owner") return;
  panel.hidden = false;
  byId("-link").hidden = false;
  const status = byId("-message");
  showMessage(status, "Loading recorded POS sales…");
  try {
    const { current, previous, weeks, days, loss_products } = await api("/api/sales/performance");
    const metrics = [
      ["revenue", "Sales after discounts"],
      ["cost", "Cost of units sold"],
      ["gross_profit", "Gross profit"]
    ];
    const dateFormat = new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", timeZone: "UTC" });
    const dateLabel = (date) => dateFormat.format(new Date(date + "T00:00:00Z"));
    const range = ({ start, end }) => dateLabel(start) + " – " + dateLabel(end);
    const amount = (value) => value == null ? "Cost needed" : productPriceLabel(value);
    const element = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    byId("-dates").textContent = current.start + " to " + current.end +
      " compared with " + previous.start + " to " + previous.end;
    byId("-totals").replaceChildren(...metrics.map(([key, label]) => {
      const card = element("article", "", "performance-total");
      let comparison = "Previous period " + amount(previous[key]);
      if (current[key] != null && previous[key] != null) {
        const change = Math.round((Number(current[key]) - Number(previous[key])) * 100) / 100;
        comparison = (change > 0 ? "Up " : change < 0 ? "Down " : "No change · ") +
          (change ? productPriceLabel(Math.abs(change)) + " · " : "") + comparison;
      }
      card.append(element("h4", label), element("strong", amount(current[key])), element("p", comparison));
      return card;
    }));

    const coverage = byId("-coverage");
    coverage.hidden = current.missing_cost_lines === 0 && previous.missing_cost_lines === 0;
    if (!coverage.hidden) {
      coverage.textContent = current.missing_cost_lines + " sale lines in the current period and " +
        previous.missing_cost_lines + " in the previous period have no recorded unit cost. " +
        "Enter purchase costs in Product Maintenance to include future checkouts in gross profit.";
    }
    const max = Math.max(1, ...weeks.flatMap((week) => metrics.map(([key]) => Math.abs(Number(week[key])))));
    byId("-weeks").replaceChildren(...weeks.map((week) => {
      const card = element("section", "", "performance-week");
      card.append(element("h5", range(week)));
      for (const [key, label] of metrics) {
        const value = week[key];
        const row = element("div", "", "performance-series performance-" + key);
        row.append(element("span", label), element("strong", amount(value)));
        const meter = document.createElement("meter");
        meter.max = max;
        meter.value = Math.abs(Number(value));
        meter.hidden = value == null;
        meter.setAttribute("aria-hidden", "true");
        row.append(meter);
        card.append(row);
      }
      return card;
    }));
    buildTable(byId("-days"), ["Date", "Units sold", ...metrics.map(([, label]) => label)],
      days.map((day) => [day.date, day.units_sold, ...metrics.map(([key]) => amount(day[key]))]));
    byId("-losses").hidden = loss_products.length === 0;
    if (loss_products.length) {
      buildTable(byId("-loss-list"), ["Product", "Barcode", "Units sold", "Gross profit"],
        loss_products.map((item) => [item.name, item.barcode, item.units_sold, amount(item.gross_profit)]));
    }
    byId("-result").hidden = false;
    showMessage(status, current.sale_lines ? "" : "No POS checkout sales were recorded in this period.");
  } catch (error) {
    showMessage(status, error.status === 404 ? "Restart Smart Stock to load the updated sales report." : error.message, "error");
  }
}

function weeklyHoldoutErrors(folds, series, methods) {
  return folds.map((fold) => {
    const days = series.filter((row) => row.date >= fold.test_from && row.date <= fold.test_through);
    const scores = Object.fromEntries(methods.map(({ method }) => {
      const valid = days.filter((row) => Number.isFinite(row.actual) && Number.isFinite(row[method]));
      const mean = valid.length
        ? valid.reduce((total, row) => total + Math.abs(row.actual - row[method]), 0) / valid.length
        : null;
      return [method, mean];
    }));
    return { date: fold.test_from, ...scores };
  });
}

function createForecastTrend(panel, number) {
  const canvas = panel.querySelector("canvas");
  let weeks = [];
  let methods = [];
  const dates = new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", timeZone: "UTC" });

  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!weeks.length || !width || !height) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    context.scale(density, density);
    const style = getComputedStyle(panel);
    const left = 42;
    const right = width - 16;
    const top = 12;
    const bottom = height - 29;
    const ceiling = Math.max(0.1, ...weeks.flatMap((row) => methods.map(({ method }) => row[method] ?? 0)));
    const x = (i) => weeks.length > 1 ? left + i * (right - left) / (weeks.length - 1) : (left + right) / 2;
    const y = (value) => bottom - value / ceiling * (bottom - top);
    context.font = "11px " + style.fontFamily;
    context.fillStyle = style.getPropertyValue("--muted").trim() || "#64748b";
    context.strokeStyle = style.getPropertyValue("--line").trim() || "#cbd5e1";
    context.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const value = ceiling * i / 4;
      const position = y(value);
      context.beginPath();
      context.moveTo(left, position);
      context.lineTo(right, position);
      context.stroke();
      context.fillText(number(value), left - 8, position + 4);
    }
    const labelInterval = Math.max(1, Math.ceil(weeks.length / Math.max(2, Math.floor(width / 83))));
    weeks.forEach((row, index) => {
      if (index % labelInterval && index !== weeks.length - 1) return;
      if (index !== weeks.length - 1 && weeks.length - 1 - index < labelInterval) return;
      context.textAlign = index === weeks.length - 1 ? "right" : index ? "center" : "left";
      context.fillText(dates.format(new Date(row.date + "T00:00:00Z")), x(index), height - 8);
    });
    methods.forEach(({ method, best }) => {
      const color = style.getPropertyValue(best ? "--insight-ai-line" : "--insight-compare-line").trim();
      context.strokeStyle = color || (best ? "#6366f1" : "#64748b");
      context.fillStyle = context.strokeStyle;
      context.lineWidth = best ? 3 : 2;
      context.lineJoin = "round";
      context.setLineDash(best ? [] : [5, 4]);
      context.beginPath();
      let hasPrevious = false;
      weeks.forEach((row, index) => {
        const value = row[method];
        if (!Number.isFinite(value)) {
          hasPrevious = false;
          return;
        }
        if (hasPrevious) context.lineTo(x(index), y(value));
        else context.moveTo(x(index), y(value));
        hasPrevious = true;
      });
      context.stroke();
      context.setLineDash([]);
      weeks.forEach((row, index) => {
        if (!Number.isFinite(row[method])) return;
        context.beginPath();
        context.arc(x(index), y(row[method]), 3, 0, Math.PI * 2);
        context.fill();
      });
    });
  }

  if (typeof ResizeObserver === "function") new ResizeObserver(draw).observe(canvas);
  if (typeof MutationObserver === "function") new MutationObserver(draw).observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-theme"],
  });
  return function render(data, selectedMethods) {
    weeks = weeklyHoldoutErrors(data.folds, data.series, selectedMethods);
    methods = selectedMethods;
    panel.hidden = !weeks.length || !methods.length;
    if (panel.hidden) return;
    document.getElementById("evaluation-trend-legend").replaceChildren(...methods.map((method) => {
      const key = document.createElement("li");
      key.dataset.best = String(method.best);
      key.textContent = method.label;
      return key;
    }));
    buildTable(document.getElementById("evaluation-weekly"), ["Week starting", ...methods.map(({ label }) => label)],
      weeks.map((row) => [row.date, ...methods.map(({ method }) => number(row[method]))]));
    requestAnimationFrame(draw);
  };
}

async function loadReports() {
  const byId = (name) => document.getElementById(name);
  const count = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const number = (value) => value == null ? "—" : count.format(value);
  const dates = (start, end) => start ? start + (end && end !== start ? " to " + end : "") : "—";
  const select = byId("report-product");
  const evaluate = byId("evaluation-run");
  const owner = currentUser.role === "owner";
  const renderTrend = createForecastTrend(byId("evaluation-trend-panel"), number);
  let selection = 0;
  let previewed = null;

  function facts(target, entries) {
    byId(target).replaceChildren(...entries.map(([label, value]) => {
      const node = document.createElement("div");
      const name = document.createElement("span");
      const amount = document.createElement("strong");
      name.textContent = label;
      amount.textContent = value;
      node.append(name, amount);
      return node;
    }));
  }

  function loadDecision(item) {
    const season = item.seasonal_evidence;
    const factsList = [
      ["Selling status", productSeasonLabels[item.sale_season] || "General product"],
      ["Sellable units", number(item.sellable_stock ?? item.current_stock)],
      ["Sold in last 28 days", number(item.sold_last_28_days)],
      ["Batch expiry", item.nearest_expiry || "Unknown"],
    ];
    if (season) {
      factsList.push(
        ["Selling window", dates(season.season_start, season.season_end)],
        ["Order review date", season.order_by || "—"],
        ["Estimated opening demand", season.opening_units_estimate == null ? "More history needed" : number(season.opening_units_estimate) + " units"],
        ["Dated stock through opening", number(season.units_usable_through_opening) + " units"],
      );
    }
    facts("decision-facts", factsList);
    byId("decision-explanation").textContent = (season?.message || item.suggested_action || "") +
      (season?.message && item.suggested_action && season.message !== item.suggested_action ? " " + item.suggested_action : "");
    const nextStockAction = item.low_stock_action ? " " + item.low_stock_action : "";
    byId("decision-expiry").textContent = (item.expiry_action || "") + nextStockAction;
    byId("decision-result").hidden = false;
    byId("season-history").hidden = !season;
    if (!season) return;
    const state = { recurring: "Recurring demand observed", limited_history: "Limited comparable history",
      mixed_evidence: "Inconsistent demand across recorded seasons" };
    byId("season-history-note").textContent = (state[season.state] || "Seasonal evidence") + ". " + (season.data_caveat || "");
    buildTable(byId("season-history-table"), ["Selling window", "Units in opening", "Total units", "Prior 28 days", "Season lift", "History coverage"],
      (season.prior_seasons || []).map((row) => [
        dates(row.season_start, row.season_end), number(row.opening_units), number(row.recorded_units),
        number(row.prior_28_day_units), row.season_lift_observed ? "Observed" : "—",
        row.complete_span ? "Window within recorded span" : "Partial record span"
      ]));
    const test = season.opening_backtest;
    byId("season-test").textContent = test
      ? "Held-out opening " + dates(test.held_out_start, test.held_out_end) + " recorded " + number(test.actual_units) +
        " units. Same-season estimate " + number(test.same_season_estimate) + " (" +
        number(test.same_season_absolute_error) + " units off). Recent 28-day estimate " +
        number(test.recent_28_day_estimate) + " (" + number(test.recent_28_day_absolute_error) + " units off)."
      : "A held-out annual comparison appears once there are enough comparable seasons.";
  }

  async function showDecision(event) {
    if (event) event.preventDefault();
    const id = select.value;
    if (!id) return;
    const requested = selection;
    const btn = byId("decision-button");
    btn.disabled = true;
    showMessage(byId("decision-message"), "Reading sales and batch evidence…");
    try {
      const item = await api("/api/ai/items/" + encodeURIComponent(id));
      if (selection !== requested) return;
      loadDecision(item);
      showMessage(byId("decision-message"), "");
    } catch (error) {
      if (selection === requested) showMessage(byId("decision-message"), error.message, "error");
    } finally {
      if (selection === requested) btn.disabled = false;
    }
  }

  function changeSelection() {
    selection += 1;
    byId("decision-button").disabled = !select.value;
    evaluate.disabled = !select.value;
    byId("decision-result").hidden = true;
    byId("evaluation-results").hidden = true;
    showMessage(byId("decision-message"), "");
    showMessage(byId("evaluation-message"), select.value ? "Ready to evaluate " + select.selectedOptions[0].textContent + "." : "Select a product above to begin.");
  }

  async function runEvaluation() {
    if (!select.value) return;
    const requested = selection;
    evaluate.disabled = true;
    byId("evaluation-results").hidden = true;
    showMessage(byId("evaluation-message"), "Running earlier-to-later forecast comparisons…");
    try {
      const data = await api("/api/ai/evaluation?product_id=" + encodeURIComponent(select.value));
      if (requested !== selection) return;
      showMessage(byId("evaluation-message"), data.message);
      if (data.status !== "evaluated") return;
      const winner = data.results.find((row) => row.method === data.recommended_method);
      const baseline = data.results.find((row) => row.method === "weekly_naive" && row.status === "evaluated");
      const comparison = byId("evaluation-comparison");
      comparison.hidden = !winner || !baseline || winner.method === baseline.method;
      if (!comparison.hidden) {
        comparison.replaceChildren(...[
          ["Prior-week baseline", baseline, false], ["Lowest holdout error", winner, true],
        ].map(([label, method, best]) => {
          const card = document.createElement("article");
          card.className = "mobile-evaluation-card";
          card.dataset.best = String(best);
          const title = document.createElement("h4");
          title.textContent = label;
          const score = document.createElement("strong");
          score.textContent = number(method.mae) + " units/day";
          const metadata = document.createElement("p");
          metadata.textContent = method.label + " · MAE";
          card.append(title, score, metadata);
          return card;
        }));
      }
      facts("evaluation-facts", [
        ["Product", data.product_name], ["Holdout dates", dates(data.validation_start, data.validation_end)],
        ["Sales records used", number(data.sales_rows_available)], ["Sales history", dates(data.sales_start, data.sales_end)],
        ["Weeks tested", number(data.folds.length)], ["Recorded validation units", number(data.validation_units)],
        ["Lowest validation MAE", winner ? winner.label + " · " + number(winner.mae) + " units/day" : "—"],
      ]);
      const scored = data.results.filter((row) => row.status === "evaluated")
        .sort((a, b) => a.mae - b.mae);
      const scale = Math.max(0.001, ...scored.map((row) => row.mae));
      const chart = byId("evaluation-chart");
      const heading = document.createElement("h4");
      heading.textContent = "Forecast error · lower is better";
      chart.replaceChildren(heading, ...scored.map((row) => {
        const line = document.createElement("div");
        line.className = "forecast-chart-row";
        line.dataset.winner = String(row.method === data.recommended_method);
        const label = document.createElement("span");
        label.textContent = row.label;
        const bar = document.createElement("meter");
        bar.max = scale;
        bar.value = row.mae;
        bar.setAttribute("aria-hidden", "true");
        const score = document.createElement("strong");
        score.textContent = number(row.mae);
        line.append(label, bar, score);
        return line;
      }));
      buildTable(byId("evaluation-table"), ["Method", "MAE", "RMSE", "WAPE", "Days", "Result"], data.results.map((row) => [
        row.label || row.method, number(row.mae), number(row.rmse), row.wape_pct == null ? "—" : number(row.wape_pct) + "%",
        number(row.days), row.status === "evaluated" ? "Evaluated" : row.reason,
      ]));
      buildTable(byId("evaluation-folds"), ["Trained through", "Test from", "Test through"], data.folds.map((row) => [
        row.train_through, row.test_from, row.test_through,
      ]));
      buildTable(byId("evaluation-series"), ["Date", "Recorded", ...data.results.map((row) => row.label)], data.series.map((row) => [
        row.date, number(row.actual), ...data.results.map((method) => number(row[method.method])),
      ]));
      byId("evaluation-results").hidden = false;
      const trendMethods = [baseline, winner].filter((row, index, rows) =>
        row && row.status === "evaluated" && (index === 0 || row.method !== rows[0]?.method));
      renderTrend(data, trendMethods.map((row) => ({
        method: row.method, label: row.label, best: row.method === winner?.method,
      })));
    } catch (error) {
      if (selection === requested) showMessage(byId("evaluation-message"), error.message, "error");
    } finally {
      if (selection === requested) evaluate.disabled = false;
    }
  }

  function showGroq(data) {
    const labels = {
      online: "Connection verified", missing_key: "API key needed", configured: "Ready to test",
      invalid_key: "Key rejected", model_unavailable: "Model unavailable", rate_limited: "Rate limited",
      unreachable: "Network unavailable", provider_error: "Provider error",
    };
    byId("groq-status").textContent = labels[data.status] || data.status;
    byId("groq-status").dataset.ready = String(data.status === "online");
    byId("groq-model").textContent = data.model;
    byId("groq-detail").textContent = data.message +
      (data.assistant_enabled ? " Inventory assistant use is enabled." : " Inventory answers use the local assistant unless the administrator enables Groq.");
    const proof = byId("groq-proof");
    const checked = data.checked_at ? new Date(data.checked_at) : null;
    proof.hidden = !checked;
    proof.textContent = checked ? [
      "Checked " + checked.toLocaleString(),
      data.latency_ms == null ? null : number(data.latency_ms) + " ms",
      data.probe_reply ? "Test reply: " + data.probe_reply : null,
    ].filter(Boolean).join(" · ") : "";
    byId("groq-test").hidden = !owner || !data.can_test;
  }

  async function loadProviders() {
    const data = await api("/api/ai/status");
    const chronos = data.chronos;
    byId("report-model-status").textContent = chronos.status === "ready" ? "Local inference verified" : "Fallback available";
    byId("report-model-status").dataset.ready = String(chronos.status === "ready");
    byId("report-model-name").textContent = chronos.model;
    byId("report-model-detail").textContent = chronos.message;
    showGroq(data.groq);
  }

  const sourceLabels = {
    partner_pos: "Authorized POS",
    public_benchmark: "Public benchmark",
    test_data: "Test data",
    unspecified: "Unspecified",
  };

  async function loadImportHistory() {
    const result = await api("/api/imports/sales");
    buildTable(byId("import-history"), ["Source", "Label", "Sales period", "Rows added", "Units", "File checksum"],
      result.batches.map((batch) => [
        sourceLabels[batch.source_type], batch.source_label, dates(batch.period_start, batch.period_end),
        number(batch.imported_rows), number(batch.units), batch.file_sha256,
      ]));
  }

  async function sendImport(commit) {
    const form = byId("sales-import-form");
    if (!form.reportValidity()) return;
    const file = byId("sales-csv").files[0];
    const source = byId("data-source").value;
    const label = byId("data-source-label").value.trim();
    if (!file || (commit && (!previewed || previewed.file !== file || previewed.source !== source || previewed.label !== label))) return;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("source_type", source);
    formData.append("source_label", label);
    formData.append("preview_only", String(!commit));
    const inputs = [...form.querySelectorAll("input, select, button")];
    inputs.forEach((input) => { input.disabled = true; });
    showMessage(byId("import-message"), commit ? "Saving validated rows…" : "Validating CSV…");
    try {
      const result = await api("/api/imports/sales", {method: "POST", body: formData});
      facts("import-facts", [
        [commit ? "Rows added" : "Valid new rows", number(commit ? result.imported_rows : result.valid_rows)],
        ["Duplicate rows", number(result.duplicate_rows)], ["Rejected rows", number(result.skipped_rows)],
        ["Products matched", number(result.unique_products)], ["Units", number(result.units)],
        ["Sales period", dates(result.period_start, result.period_end)],
      ]);
      byId("import-errors").replaceChildren(...(result.errors || []).slice(0, 10).map((entry) => {
        const row = document.createElement("li");
        row.textContent = typeof entry === "string" ? entry : "Row " + (entry.row ?? entry.line ?? "—") + " · " + (entry.error || entry.message);
        return row;
      }));
      byId("import-result").hidden = false;
      previewed = !commit && source === "partner_pos" && result.valid_rows > 0 ? {file, source, label} : null;
      byId("import-confirm").hidden = !previewed;
      showMessage(byId("import-message"), result.note || "CSV validation completed.", "success");
      if (commit) await loadImportHistory();
    } catch (error) {
      showMessage(byId("import-message"), error.message, "error");
    } finally {
      inputs.forEach((input) => { input.disabled = false; });
    }
  }

  byId("decision-form").addEventListener("submit", showDecision);
  select.addEventListener("change", changeSelection);
  evaluate.addEventListener("click", runEvaluation);
  byId("groq-test").addEventListener("click", async () => {
    const btn = byId("groq-test");
    btn.disabled = true;
    byId("groq-status").textContent = "Waiting for Groq…";
    try { showGroq(await api("/api/ai/status/groq", {method: "POST"})); }
    catch (error) { byId("groq-status").textContent = error.message; }
    finally { btn.disabled = false; }
  });

  if (owner) {
    byId("import-locked").hidden = true;
    byId("import-owner").hidden = false;
    byId("import-template").hidden = false;
    byId("sales-import-form").addEventListener("submit", (event) => { event.preventDefault(); void sendImport(false); });
    byId("sales-import-form").addEventListener("input", () => {
      previewed = null;
      byId("import-confirm").hidden = true;
      byId("import-result").hidden = true;
      showMessage(byId("import-message"), "");
    });
    byId("import-confirm").addEventListener("click", () => void sendImport(true));
    loadImportHistory().catch((error) => showMessage(byId("import-message"), error.message, "error"));
  }

  const productList = api("/api/products").then((items) => {
    items.forEach((item) => select.append(new Option(item.product_name + " · " + item.product_barcode, item.product_id)));
    const initial = new URLSearchParams(location.search).get("product_id");
    if (initial && items.some((item) => String(item.product_id) === initial)) select.value = initial;
    changeSelection();
    if (select.value) void showDecision();
  });
  await Promise.all([productList, loadProviders(), loadSalesPerformance()]);
}
