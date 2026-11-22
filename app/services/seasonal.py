from __future__ import annotations

from calendar import monthrange
from datetime import date, timedelta
from math import ceil
from statistics import median


OPENING_DAYS = 14
COMPARABLE_YEARS = 4
RECENT_WINDOW_DAYS = 28


def season_dates(year: int, start_month: int, end_month: int) -> tuple[date, date]:
    end_year = year + int(end_month < start_month)
    return date(year, start_month, 1), date(end_year, end_month, monthrange(end_year, end_month)[1])


def current_or_next_season(today: date, start_month: int, end_month: int) -> tuple[date, date]:
    previous = season_dates(today.year - 1, start_month, end_month)
    if previous[0] <= today <= previous[1]:
        return previous
    current = season_dates(today.year, start_month, end_month)
    return current if today <= current[1] else season_dates(today.year + 1, start_month, end_month)


def season_history_floor(today: date, start_month: int, end_month: int) -> date:
    start, _ = current_or_next_season(today, start_month, end_month)
    return date(start.year - COMPARABLE_YEARS, start_month, 1) - timedelta(days=RECENT_WINDOW_DAYS)


def summarize_expiry(
    today: date,
    stock: int,
    batches: list[tuple[date | None, int]],
    *,
    upcoming_season: date | None = None,
    forecast_before_expiry: float | None = None,
) -> dict:
    dated = [(expiry, quantity) for expiry, quantity in batches if expiry is not None and quantity > 0]
    live_dated = [(expiry, quantity) for expiry, quantity in dated if expiry >= today]
    expired = sum(quantity for expiry, quantity in dated if expiry < today)
    undated = sum(quantity for expiry, quantity in batches if expiry is None and quantity > 0)
    unbatched = max(0, stock - sum(quantity for _, quantity in batches if quantity > 0))
    unknown = undated + unbatched
    sellable = min(max(0, stock), undated + sum(quantity for _, quantity in live_dated))
    before_season = sum(quantity for expiry, quantity in live_dated
                        if upcoming_season is not None and expiry < upcoming_season)
    nearest = min((expiry for expiry, _ in live_dated), default=None)
    nearest_quantity = sum(quantity for expiry, quantity in live_dated if expiry == nearest)
    forecast_risk = (
        forecast_before_expiry is not None and nearest_quantity > 0
        and nearest_quantity > forecast_before_expiry
    )
    if expired:
        status = "expired"
        action = f"{expired} expired units must be removed from sellable stock."
    elif before_season:
        status = "watch"
        action = f"{before_season} units expire before the next selling season. Plan to sell or transfer them in time."
    elif nearest is not None and ((nearest - today).days <= OPENING_DAYS or forecast_risk):
        status = "watch"
        action = f"Review the {nearest_quantity} units in the nearest dated batch, expiring {nearest.isoformat()}."
    elif unknown:
        status = "unknown"
        action = f"Verify batch expiry for {unknown} units with missing dates."
    elif live_dated:
        status = "clear"
        action = "No dated batch currently meets the expiry alert rules."
    else:
        status = "none"
        action = "There is no current batch stock to assess."
    return {
        "sellable_stock": sellable,
        "expiry_status": status,
        "expiry_action": action,
        "expired_units": expired,
        "unknown_expiry_units": unknown,
        "unbatched_units": unbatched,
    }


def _opening_backtest(daily_sales: dict[date, float], previous: list[dict], coverage_start: date) -> dict | None:
    if len(previous) < 3:
        return None
    held = previous[-1]
    training = previous[:-1]
    start = held["season_start"]
    baseline_start = start - timedelta(days=RECENT_WINDOW_DAYS)
    if coverage_start > baseline_start or sum(window["season_lift_observed"] for window in training) < 2:
        return None
    actual = held["opening_units"]
    annual = median(window["opening_units"] for window in training)
    recent = sum(quantity for day, quantity in daily_sales.items() if baseline_start <= day < start)
    baseline = recent * OPENING_DAYS / RECENT_WINDOW_DAYS
    return {
        "held_out_start": start,
        "held_out_end": held["opening_end"],
        "days": OPENING_DAYS,
        "actual_units": actual,
        "same_season_estimate": round(annual, 2),
        "same_season_absolute_error": round(abs(actual - annual), 2),
        "recent_28_day_estimate": round(baseline, 2),
        "recent_28_day_absolute_error": round(abs(actual - baseline), 2),
        "training_seasons": len(training),
    }


def build_seasonal_evidence(
    *,
    today: date,
    start_month: int,
    end_month: int,
    daily_sales: dict[date, float],
    coverage_start: date,
    batches: list[tuple[date | None, int]],
    stock: int,
    supplier_lead_days: int,
    safety_stock: int,
) -> dict:
    season_start, season_end = current_or_next_season(today, start_month, end_month)
    opening_end = season_start + timedelta(days=OPENING_DAYS - 1)
    order_by = season_start - timedelta(days=supplier_lead_days)
    upcoming = today < season_start
    previous = []
    for year in range(season_start.year - COMPARABLE_YEARS, season_start.year):
        start, end = season_dates(year, start_month, end_month)
        period_opening_end = start + timedelta(days=OPENING_DAYS - 1)
        active_days = {
            day: qty for day, qty in daily_sales.items()
            if start <= day <= end and day < today and qty > 0
        }
        recorded_units = sum(active_days.values())
        before_start = start - timedelta(days=RECENT_WINDOW_DAYS)
        before_units = (
            sum(quantity for day, quantity in daily_sales.items() if before_start <= day < start)
            if coverage_start <= before_start else None
        )
        season_days = (end - start).days + 1
        previous.append({
            "season_start": start,
            "season_end": end,
            "opening_end": period_opening_end,
            "opening_units": sum(qty for day, qty in active_days.items() if day <= period_opening_end),
            "recorded_units": recorded_units,
            "selling_days": len(active_days),
            "complete_span": coverage_start <= start and end < today,
            "prior_28_day_units": before_units,
            "season_lift_observed": (
                before_units is not None and recorded_units > 0
                and recorded_units / season_days > before_units / RECENT_WINDOW_DAYS
            ),
        })

    comparable = [window for window in previous if window["complete_span"]]
    recurring = sum(window["recorded_units"] > 0 for window in comparable)
    lift_seasons = sum(window["season_lift_observed"] for window in comparable)
    estimate = round(median(window["opening_units"] for window in comparable), 2) if lift_seasons >= 2 else None
    confirmed_stock = sum(
        quantity for expiry, quantity in batches
        if expiry is not None and expiry >= max(today, season_start) and quantity > 0
    )
    confirmed_stock = min(max(0, stock), confirmed_stock)
    through_opening = sum(
        quantity for expiry, quantity in batches
        if expiry is not None and expiry >= max(today, opening_end) and quantity > 0
    )
    through_opening = min(max(0, stock), through_opening)
    expiring_stock = sum(
        quantity for expiry, quantity in batches
        if expiry is not None and today <= expiry < season_start and quantity > 0
    )
    reorder_units = max(0, ceil(estimate) + safety_stock - through_opening) if upcoming and estimate is not None else None
    if estimate is not None:
        state = "recurring"
        message = (
            f"{lift_seasons} of {len(comparable)} comparable seasons had a higher daily selling rate than the previous "
            "28 days. The opening estimate uses the first 14 days of comparable seasons."
        )
    elif len(comparable) >= 2 and recurring:
        state = "mixed_evidence"
        message = (
            f"Sales were recorded in {recurring} comparable seasons. Review the configured months and recorded sales "
            "before setting an opening quantity."
        )
    else:
        state = "limited_history"
        message = "Build two comparable seasons with a higher daily sales rate before setting an estimated opening quantity."
    return {
        "state": state,
        "season_start": season_start,
        "season_end": season_end,
        "order_by": order_by,
        "order_due": upcoming and today >= order_by,
        "opening_days": OPENING_DAYS,
        "opening_end": opening_end,
        "opening_units_estimate": estimate,
        "recurring_seasons": recurring,
        "season_lift_years": lift_seasons,
        "prior_seasons": list(reversed(previous)),
        "units_usable_at_start": confirmed_stock,
        "units_usable_through_opening": through_opening,
        "units_expiring_before_start": expiring_stock,
        "reorder_units": reorder_units,
        "opening_backtest": _opening_backtest(daily_sales, comparable, coverage_start),
        "message": message,
        "data_caveat": "Coverage is inferred from catalog and sales dates. Missing days and stockouts can depress recorded sales.",
    }
