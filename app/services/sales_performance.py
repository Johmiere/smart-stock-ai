from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import text
from sqlalchemy.orm import Session


ZERO = Decimal("0.00")
PERIOD_DAYS = 28


def money(value) -> Decimal:
    return Decimal(str(value if value is not None else 0)).quantize(ZERO)


def summarize(days: list[dict]) -> dict:
    revenue = sum((day["revenue"] for day in days), ZERO)
    missing = sum(day["missing_cost_lines"] for day in days)
    cost = None if missing else sum((day["cost"] for day in days), ZERO)
    return {
        "start": days[0]["date"],
        "end": days[-1]["date"],
        "revenue": revenue,
        "cost": cost,
        "gross_profit": revenue - cost if cost is not None else None,
        "missing_cost_lines": missing,
        "sale_lines": sum(day["sale_lines"] for day in days),
        "units_sold": sum(day["units_sold"] for day in days),
    }


def sales_performance(db: Session, store_id: int, today: date) -> dict:
    current_start = today - timedelta(days=PERIOD_DAYS - 1)
    previous_start = current_start - timedelta(days=PERIOD_DAYS)
    end = today + timedelta(days=1)
    params = {"store_id": store_id, "start": previous_start, "end": end}
    recorded = db.execute(
        text(
            "SELECT DATE(sale_date) AS sale_day, COUNT(*) AS sale_lines, SUM(sale_quantity) AS units_sold, "
            "SUM(sale_quantity * sale_unit_price - COALESCE(sale_discount_amount, 0)) AS revenue, "
            "SUM(sale_quantity * sale_unit_cost) AS cost, "
            "SUM(CASE WHEN sale_unit_cost IS NULL THEN 1 ELSE 0 END) AS missing_cost_lines "
            "FROM sales WHERE store_id = :store_id AND sale_transaction_id IS NOT NULL "
            "AND sale_date >= :start AND sale_date < :end GROUP BY DATE(sale_date)"
        ),
        params,
    ).mappings()
    by_day = {str(row["sale_day"]): row for row in recorded}
    days = []
    for offset in range(2 * PERIOD_DAYS):
        day = (previous_start + timedelta(days=offset)).isoformat()
        row = by_day.get(day, {})
        missing = int(row.get("missing_cost_lines", 0))
        revenue = money(row.get("revenue"))
        cost = None if missing else money(row.get("cost"))
        days.append({
            "date": day,
            "revenue": revenue,
            "cost": cost,
            "gross_profit": revenue - cost if cost is not None else None,
            "missing_cost_lines": missing,
            "sale_lines": int(row.get("sale_lines", 0)),
            "units_sold": int(row.get("units_sold", 0)),
        })

    loss_rows = db.execute(
        text(
            "SELECT p.product_name, p.product_barcode, SUM(s.sale_quantity) AS units_sold, "
            "SUM(s.sale_quantity * s.sale_unit_price - COALESCE(s.sale_discount_amount, 0)) AS revenue, "
            "SUM(s.sale_quantity * s.sale_unit_cost) AS cost "
            "FROM sales s JOIN product p ON p.store_id = s.store_id AND p.product_id = s.product_id "
            "WHERE s.store_id = :store_id AND s.sale_transaction_id IS NOT NULL "
            "AND s.sale_date >= :start AND s.sale_date < :end "
            "GROUP BY p.product_id, p.product_name, p.product_barcode "
            "HAVING COUNT(*) = COUNT(s.sale_unit_cost) "
            "AND SUM(s.sale_quantity * (s.sale_unit_price - s.sale_unit_cost) "
            "- COALESCE(s.sale_discount_amount, 0)) < 0 "
            "ORDER BY SUM(s.sale_quantity * (s.sale_unit_price - s.sale_unit_cost) "
            "- COALESCE(s.sale_discount_amount, 0)), p.product_id LIMIT 5"
        ),
        {**params, "start": current_start},
    ).mappings()
    losses = []
    for row in loss_rows:
        revenue, cost = money(row["revenue"]), money(row["cost"])
        if revenue < cost:
            losses.append({
                "name": row["product_name"], "barcode": row["product_barcode"],
                "units_sold": int(row["units_sold"]), "gross_profit": revenue - cost,
            })
    current = days[PERIOD_DAYS:]
    return {
        "current": summarize(current),
        "previous": summarize(days[:PERIOD_DAYS]),
        "weeks": [summarize(current[i:i + 7]) for i in range(0, PERIOD_DAYS, 7)],
        "days": current,
        "loss_products": losses,
    }
