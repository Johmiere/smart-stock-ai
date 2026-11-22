"use strict";

const reorderDateFormat = new Intl.DateTimeFormat("en-PH", {
  month: "short", day: "numeric", timeZone: "UTC"
});

function reorderDateLabel(day) {
  const parsed = new Date(day + "T00:00:00Z");
  return Number.isNaN(+parsed) ? day : reorderDateFormat.format(parsed);
}

function isReorderPayday(day) {
  const parsed = new Date(day + "T00:00:00Z");
  return !Number.isNaN(+parsed) && (parsed.getUTCDate() === 15 ||
    new Date(+parsed + 86400000).getUTCDate() === 1);
}

function reorderChartSegments(points, predicate) {
  const segments = [];
  let segment;
  points.forEach((point, index) => {
    if (!predicate(point)) {
      segment = undefined;
      return;
    }
    if (!segment) {
      segment = [];
      segments.push(segment);
    }
    segment.push({ point, index });
  });
  return segments;
}

function drawReorderForecast(canvas, points) {
  if (!points.length || !canvas.clientWidth) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.scale(scale, scale);

  const colors = getComputedStyle(canvas);
  const violet = colors.getPropertyValue("--orders-ai").trim() || "#6366f1";
  const inset = { top: 13, right: 13, bottom: 26, left: 34 };
  const high = Math.max(1, ...points.flatMap((point) => [point.p50, point.p90].filter(Number.isFinite))) * 1.12;
  const chartWidth = width - inset.left - inset.right;
  const chartHeight = height - inset.top - inset.bottom;
  const x = (i) => inset.left + chartWidth * (points.length === 1 ? .5 : i / (points.length - 1));
  const y = (value) => inset.top + chartHeight * (1 - value / high);
  const label = new Intl.NumberFormat("en-PH", { maximumFractionDigits: high < 4 ? 1 : 0 });
  context.font = "11px " + colors.fontFamily;
  context.fillStyle = colors.getPropertyValue("--muted").trim() || "#475569";
  context.strokeStyle = colors.getPropertyValue("--line").trim() || "#dbe4ef";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (const ratio of [0, .33, .67, 1]) {
    const gridY = y(high * ratio);
    context.beginPath();
    context.moveTo(inset.left, gridY);
    context.lineTo(width - inset.right, gridY);
    context.stroke();
    context.fillText(label.format(high * ratio), inset.left - 5, gridY);
  }
  const last = points.length - 1;
  const ticks = new Set([0, Math.floor(last / 2), last]);
  ticks.forEach((index) => {
    context.textAlign = index === 0 ? "left" : index === last ? "right" : "center";
    context.fillText(reorderDateLabel(points[index].date), x(index), height - 9);
  });
  context.save();
  context.setLineDash([3, 3]);
  context.strokeStyle = colors.getPropertyValue("--muted").trim() || "#475569";
  context.globalAlpha = .6;
  points.forEach((point, index) => {
    if (!isReorderPayday(point.date)) return;
    context.beginPath();
    context.moveTo(x(index), inset.top);
    context.lineTo(x(index), height - inset.bottom);
    context.stroke();
  });
  context.restore();

  const bands = reorderChartSegments(points, (point) => Number.isFinite(point.p10) && Number.isFinite(point.p90));
  context.fillStyle = violet;
  context.globalAlpha = .21;
  for (const band of bands) {
    if (band.length < 2) continue;
    context.beginPath();
    band.forEach(({ point, index }, i) => context[i === 0 ? "moveTo" : "lineTo"](x(index), y(point.p90)));
    [...band].reverse().forEach(({ point, index }) => context.lineTo(x(index), y(point.p10)));
    context.closePath();
    context.fill();
  }
  context.globalAlpha = 1;
  context.strokeStyle = violet;
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  const median = reorderChartSegments(points, (point) => Number.isFinite(point.p50));
  median.forEach((segment) => {
    context.beginPath();
    segment.forEach(({ point, index }, i) => context[i === 0 ? "moveTo" : "lineTo"](x(index), y(point.p50)));
    context.stroke();
    const last = segment.at(-1);
    context.beginPath();
    context.arc(x(last.index), y(last.point.p50), 3, 0, Math.PI * 2);
    context.fill();
  });
}

async function initReorder() {
  const byId = (id) => document.getElementById(id);
  const message = byId("page-message");
  const detail = byId("reorder-detail");
  const detailMessage = byId("reorder-detail-message");
  const reviewDialog = byId("reorder-review-dialog");
  const reviewMessage = byId("reorder-review-message");
  const reviewForm = byId("reorder-review");
  const chart = byId("reorder-chart");
  const chartFigure = byId("reorder-chart-figure");
  const periodButtons = Array.from(detail.querySelectorAll("[data-forecast-days]"));
  const number = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 });
  const format = (value) => value == null ? "—" : number.format(value);
  const actions = {
    approve: { title: "Approve draft", button: "Confirm approval", help: "Save this store approval. Place the order directly with your supplier." },
    edit: { title: "Edit quantity", button: "Save quantity", help: "Change the quantity and leave a note for the next reviewer." },
    reject: { title: "Reject draft", button: "Confirm rejection", help: "Give a reason to close this draft and record the decision." },
  };
  const states = {
    pending: ["◷", "Pending"], approved: ["✓", "Approved"], rejected: ["×", "Rejected"],
    suggested: ["✦", "Suggested"], supplier: ["!", "Set supplier"], hold: ["○", "Review stock"],
  };
  let selected;
  let reviewing;
  let busy = false;
  let period = 7;
  let chartPoints = [];
  let recommendations = [];

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function button(text, style, onClick, label) {
    const control = node("button", "btn " + style, text);
    control.type = "button";
    control.setAttribute("aria-label", label);
    control.addEventListener("click", onClick);
    return control;
  }

  function statusChip(status) {
    const [icon, label] = states[status] || ["○", status];
    const chip = node("span", "orders-status");
    const mark = node("span", null, icon);
    mark.setAttribute("aria-hidden", "true");
    chip.dataset.status = status;
    chip.append(mark, document.createTextNode(label));
    return chip;
  }

  function emptyState(title, description) {
    const empty = node("div", "orders-empty");
    const mark = node("span", "orders-empty-mark", "✓");
    mark.setAttribute("aria-hidden", "true");
    empty.append(mark, node("strong", null, title), node("p", null, description));
    return empty;
  }

  function groupedCards(target, rows, supplierName, card, empty) {
    target.replaceChildren();
    if (!rows.length) {
      target.append(emptyState(...empty));
      return;
    }
    const groups = new Map();
    rows.forEach((row) => {
      const supplier = supplierName(row) || "Unassigned supplier";
      if (!groups.has(supplier)) groups.set(supplier, []);
      groups.get(supplier).push(row);
    });
    [...groups].sort(([a], [b]) => a.localeCompare(b)).forEach(([supplier, records]) => {
      const group = node("section", "orders-group");
      const grid = node("div", "orders-grid");
      grid.append(...records.map(card));
      group.append(node("h4", "orders-group-heading", supplier), grid);
      target.append(group);
    });
  }

  function itemCard(name, context, status, facts, controls) {
    const card = node("article", "orders-card");
    const title = node("div", "orders-card-title");
    const copy = node("div");
    copy.append(node("h4", null, name), node("p", "orders-card-subtitle", context));
    title.append(copy, statusChip(status));
    const list = node("dl", "orders-card-facts");
    facts.forEach(([label, value]) => {
      const pair = node("div");
      pair.append(node("dt", null, label), node("dd", null, format(value)));
      list.append(pair);
    });
    const row = node("div", "orders-card-actions");
    row.append(...controls);
    card.append(title, list, row);
    return card;
  }

  function recommendationCard(row) {
    const status = row.quantity ? row.supplier ? "suggested" : "supplier" : "hold";
    return itemCard(row.name, row.sku, status, [
      ["Sellable stock", row.stock], ["Days left", row.days_remaining], ["Suggested qty", row.quantity]
    ], [button("Why?", "orders-why", () => openEvidence(row), "Why? Forecast evidence for " + row.name)]);
  }

  function draftCard(row) {
    const item = row.snapshot;
    const controls = [];
    if (row.status === "pending") {
      controls.push(
        button("Approve", "btn-primary", () => beginReview(row, "approve"), "Approve draft " + row.id),
        button("Edit", "btn-secondary", () => beginReview(row, "edit"), "Edit draft " + row.id),
        button("Reject", "orders-reject", () => beginReview(row, "reject"), "Reject draft " + row.id)
      );
    }
    controls.push(button("Why?", "orders-why", () => openEvidence(item, true), "Why? Evidence for draft " + row.id));
    return itemCard(item.name, item.sku + " · Draft #" + row.id + " · " + reorderDateLabel(row.created_day), row.status, [
      ["Days left", item.days_remaining], ["Suggested qty", item.quantity], ["Draft qty", row.quantity]
    ], controls);
  }

  function renderRecommendations() {
    const query = byId("reorder-search").value.trim().toLocaleLowerCase();
    const rows = recommendations.filter((row) => !query ||
      [row.name, row.sku, row.supplier].some((value) => value?.toLocaleLowerCase().includes(query)));
    groupedCards(byId("reorder-products"), rows, (row) => row.supplier, recommendationCard,
      query ? ["No matching items", "Try a different item name, SKU, or supplier."] :
        ["No forecasts yet", "Add products in Product Maintenance to get started."]);
  }

  function renderForecast(row) {
    const points = Array.isArray(row.daily) ? row.daily : [];
    chartPoints = points.slice(0, period);
    const hasMedian = chartPoints.some((point) => Number.isFinite(point.p50));
    const hasBand = reorderChartSegments(chartPoints, (point) =>
      Number.isFinite(point.p10) && Number.isFinite(point.p90)).some((segment) => segment.length > 1);
    periodButtons.forEach((control) => {
      const days = Number(control.dataset.forecastDays);
      control.disabled = days === 30 && points.length <= 7;
      control.setAttribute("aria-pressed", String(period === days));
      if (days === 30) {
        control.title = points.length < 30 ? "Available horizon: " + points.length + " days" : "";
      }
    });
    let note = "There is not enough data for a daily forecast.";
    if (hasMedian) {
      note = (chartPoints.length < period ? chartPoints.length + " days available" :
        chartPoints.length + "-day forecast") + " · " + row.method;
      if (!hasBand) note += " · Single estimate";
      if (points.length <= 7) note += " · 7 days available";
    }
    const markedDates = chartPoints.filter((point) => isReorderPayday(point.date)).map((point) => reorderDateLabel(point.date));
    byId("reorder-forecast-note").textContent = note + (markedDates.length
      ? " · Payday calendar markers: " + markedDates.join(", ") : "");
    byId("reorder-legend-median").textContent = hasBand ? "P50 median" : "Daily estimate";
    byId("reorder-legend-range").hidden = !hasBand;
    chartFigure.hidden = !hasMedian;
    byId("reorder-band").parentElement.hidden = !chartPoints.length;
    buildTable(byId("reorder-band"), ["Day", "P10", "P50 / estimate", "P90"],
      chartPoints.map((point) => [point.date, format(point.p10), format(point.p50), format(point.p90)]));
    if (hasMedian && detail.open) requestAnimationFrame(() => drawReorderForecast(chart, chartPoints));
  }

  function showEvidence(row, saved) {
    selected = { row, saved };
    byId("reorder-detail-name").textContent = row.name + " · " + row.sku;
    byId("reorder-explanation").textContent = row.reason + " Forecast: " + row.method +
      ". Safety stock: " + row.buffer_method + " (" + row.sample_blocks + " historical blocks).";
    byId("reorder-supplier").hidden = saved;
    byId("supplier-name").value = row.supplier || "";
    byId("supplier-lead").value = row.lead || "";
    renderForecast(row);
  }

  function openEvidence(row, saved = false) {
    period = 7;
    showMessage(detailMessage, "", "");
    showEvidence(row, saved);
    detail.showModal();
    byId("reorder-detail-name").focus();
    requestAnimationFrame(() => drawReorderForecast(chart, chartPoints));
  }

  function beginReview(row, action) {
    reviewing = { row, action };
    reviewForm.reset();
    showMessage(reviewMessage, "", "");
    byId("reorder-review-title").textContent = actions[action].title;
    byId("reorder-reviewing").textContent = row.snapshot.name + " · " + format(row.quantity) +
      " units · " + (row.snapshot.supplier || "Unassigned supplier");
    byId("reorder-review-help").textContent = actions[action].help;
    byId("review-submit").textContent = actions[action].button;
    byId("review-submit").classList.toggle("orders-reject", action === "reject");
    byId("review-quantity-field").hidden = action !== "edit";
    byId("review-quantity").required = action === "edit";
    byId("review-quantity").value = row.quantity;
    byId("review-note").required = action !== "approve";
    byId("review-note-label").textContent = action === "approve" ? "Decision note (optional)" : "Reason";
    reviewDialog.showModal();
    if (action === "edit") byId("review-quantity").focus();
    if (action === "reject") byId("review-note").focus();
  }

  async function load() {
    const data = await api("/api/reorder");
    byId("reorder-workspace").hidden = false;
    byId("reorder-branch").textContent = (data.store_name || "Store " + data.store_id) +
      " · Forecast as of " + reorderDateLabel(data.today);
    recommendations = data.recommendations;
    renderRecommendations();
    if (selected && !selected.saved && detail.open) {
      const row = recommendations.find((item) => item.product_id === selected.row.product_id);
      if (row) showEvidence(row, false);
    }
    const pending = data.drafts.filter((row) => row.status === "pending");
    const reviewed = data.drafts.filter((row) => row.status !== "pending");
    byId("reorder-pending-count").textContent = format(pending.length);
    byId("reorder-review-count").textContent = format(reviewed.length);
    byId("reorder-review-bar-count").textContent = format(pending.length) +
      (pending.length === 1 ? " pending draft" : " pending drafts");
    byId("reorder-review-bar").hidden = !pending.length;
    groupedCards(byId("reorder-drafts"), pending, (row) => row.snapshot.supplier, draftCard,
      ["No pending drafts", "Create suggested drafts when you have items to reorder."]);
    groupedCards(byId("reorder-reviewed"), reviewed, (row) => row.snapshot.supplier, draftCard,
      ["No reviewed drafts yet", "Approved and rejected drafts will appear here."]);
    buildTable(byId("reorder-audit"), ["Draft", "User ID", "Decision", "From", "To", "Note", "Timestamp"],
      data.decisions.map((row) => [row.draft_id, row.user_id, row.action, row.previous_quantity, row.quantity, row.note, row.recorded_at]));
  }

  async function submit(control, target, action, afterSave) {
    if (busy) return;
    busy = true;
    control.disabled = true;
    showMessage(target, "Saving…");
    try {
      const result = await action();
      try {
        await load();
        if (afterSave) afterSave();
        showMessage(target === reviewMessage ? message : target, result, "success");
      } catch (error) {
        if (afterSave) afterSave();
        showMessage(target === reviewMessage ? message : target, result + " Refresh to update the view.", "success");
      }
    } catch (error) {
      showMessage(target, error.message, "error");
      if (target === reviewMessage && error.status === 409) {
        reviewDialog.close();
        showMessage(message, error.message, "error");
        await load().catch(() => {});
      }
    } finally {
      busy = false;
      control.disabled = false;
    }
  }

  const generate = byId("reorder-generate");
  generate.addEventListener("click", () => submit(generate, message, async () => {
    const result = await api("/api/reorder/drafts", { method: "POST" });
    return result.created ? "Created " + result.created + " purchase drafts." : "No new eligible drafts for today.";
  }));
  byId("reorder-search").addEventListener("input", renderRecommendations);
  byId("reorder-jump").addEventListener("click", () => {
    const title = byId("pending-orders-heading");
    title.focus({ preventScroll: true });
    title.scrollIntoView({ block: "center" });
  });
  byId("reorder-supplier").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!selected || selected.saved) return;
    const control = event.submitter || event.currentTarget.querySelector("button");
    void submit(control, detailMessage, async () => {
      await api("/api/reorder/products/" + selected.row.product_id + "/supplier", {
        method: "PUT", body: { supplier: byId("supplier-name").value, lead: Number(byId("supplier-lead").value) }
      });
      return "Supplier settings saved.";
    });
  });
  reviewForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!reviewing) return;
    const { row, action } = reviewing;
    const control = event.submitter || byId("review-submit");
    void submit(control, reviewMessage, async () => {
      await api("/api/reorder/drafts/" + row.id + "/decision", {
        method: "POST", body: {
          action, version: row.version, note: byId("review-note").value,
          quantity: action === "edit" ? Number(byId("review-quantity").value) : null
        }
      });
      return "Decision recorded.";
    }, () => {
      reviewDialog.close();
      byId("pending-orders-heading").focus();
    });
  });
  [detail, reviewDialog].forEach((dialog) => {
    dialog.querySelector("[data-orders-close]").addEventListener("click", () => {
      if (!busy) dialog.close();
    });
    dialog.addEventListener("cancel", (event) => {
      if (busy) event.preventDefault();
    });
  });
  periodButtons.forEach((control) => control.addEventListener("click", () => {
    period = Number(control.dataset.forecastDays);
    if (selected) renderForecast(selected.row);
  }));
  const redraw = () => {
    if (detail.open && !chartFigure.hidden) drawReorderForecast(chart, chartPoints);
  };
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(redraw).observe(chart);
  } else {
    window.addEventListener("resize", redraw);
  }
  try {
    await load();
  } catch (error) {
    const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    if (error.status !== 404 || !local || !["8000", "8002"].includes(window.location.port)) throw error;
    const destination = new URL("/reorder.html", window.location.origin);
    destination.port = "8004";
    showMessage(message, "Opening purchase orders…");
    window.location.replace(destination);
  } finally {
    byId("reorder-skeleton").hidden = true;
  }
}
