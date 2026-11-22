from __future__ import annotations

import math
from datetime import date


def is_in_season(start_month: int | None, end_month: int | None, current_month: int) -> bool:
    if start_month is None or end_month is None:
        return False
    if start_month <= end_month:
        return start_month <= current_month <= end_month
    return current_month >= start_month or current_month <= end_month


def product_season(start_month: int | None, end_month: int | None, current_month: int) -> str:
    if start_month is None or end_month is None:
        return "general"
    return "in_season" if is_in_season(start_month, end_month, current_month) else "off_season"


def days_until_next_season(start_month: int, today: date) -> int:
    next_year = today.year + int(today.month >= start_month)
    return (date(next_year, start_month, 1) - today).days


def classify_item(
    stock: int,
    expiry_demand: float | None,
    sold_last_28_days: float,
    lead_time_demand: float,
    safety_stock: int,
    *,
    expiring_stock: int,
    expiry_status: str,
    expiry_action: str,
    evaluate_recent_sales: bool,
    reorder_point: int,
    off_season: bool,
    seasonal_evidence: dict | None,
) -> dict:
    unsold_at_expiry = None if expiry_demand is None else max(0.0, expiring_stock - expiry_demand)
    red_by_no_sales = stock > 0 and evaluate_recent_sales and sold_last_28_days <= 0
    red_by_unsold = (
        expiring_stock > 0 and unsold_at_expiry is not None and unsold_at_expiry >= 0.5 * expiring_stock
    )
    if off_season and seasonal_evidence is not None:
        risk = "off_season"
        if seasonal_evidence["state"] == "mixed_evidence":
            action = "Check that the configured months match the product's sales before relying on a seasonal order."
        elif not seasonal_evidence["order_due"]:
            order_by = seasonal_evidence["order_by"].isoformat()
            action = f"Hold routine reorders until the supplier planning date, {order_by}."
        elif seasonal_evidence["reorder_units"] is None:
            action = "The supplier lead-time window has arrived. Review opening quantities with the buyer because comparable sales history is limited."
        elif seasonal_evidence["reorder_units"]:
            action = "The supplier lead-time window has arrived. Check the seasonal reorder estimate."
        else:
            action = "Current dated stock covers the estimated season opening and the safety stock target."
        if expiry_status in {"expired", "watch", "unknown"}:
            action += f" {expiry_action}"
        # Recent quiet weeks do not estimate sales during the coming season.
        unsold_at_expiry = None
    elif expiry_status == "expired":
        risk = "red"
        action = expiry_action
    elif red_by_no_sales:
        risk = "red"
        action = "No sales were recorded in the last 28 days. Consider a discount, bundle, or repositioning."
    elif red_by_unsold:
        risk = "red"
        action = "Consider a discount, bundle with a fast-moving item, or reposition the product."
    elif unsold_at_expiry is not None and 0 < unsold_at_expiry < 0.5 * expiring_stock:
        risk = "yellow"
        action = "Monitor this batch and consider a light promotion."
    elif not evaluate_recent_sales:
        risk = "unknown"
        action = expiry_action if expiry_status == "watch" else "Review sales after more days are recorded before deciding on a markdown."
    elif expiry_demand is None:
        risk = "unknown"
        action = expiry_action
    else:
        risk = "green"
        action = "Estimated demand covers the nearest dated batch."

    if off_season and seasonal_evidence is not None:
        estimate = seasonal_evidence["opening_units_estimate"]
        reorder_units = seasonal_evidence["reorder_units"] or 0
        low_stock_threshold = None if estimate is None else math.ceil(estimate) + safety_stock
        low_stock = seasonal_evidence["order_due"] and reorder_units > 0
        reorder_action = f"Plan to order approximately {reorder_units} units for the next season."
    else:
        low_stock_threshold = max(reorder_point, lead_time_demand + safety_stock)
        low_stock = stock <= low_stock_threshold
        reorder_units = max(0, math.ceil(low_stock_threshold - stock))
        reorder_action = (
            f"Reorder approximately {reorder_units} units."
            if reorder_units else "Stock has reached its reorder point. Review incoming orders."
        )
    return {
        "status": risk,
        "unsold_at_expiry": None if unsold_at_expiry is None else round(unsold_at_expiry, 2),
        "low_stock": low_stock,
        "low_stock_threshold": round(low_stock_threshold, 2) if low_stock_threshold is not None else None,
        "low_stock_action": reorder_action if low_stock else None,
        "suggested_action": action,
    }
