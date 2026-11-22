from datetime import date, datetime, timedelta
import json
import math
from statistics import median, mean
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import Column, Date, Integer, MetaData, String, Table, Text, UniqueConstraint, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.security import current_user, require_csrf, require_owner
from app.services.classification import product_season
from app.services.forecasting import MAX_FORECAST_DAYS


metadata = MetaData()
drafts = Table(
    "reorder_draft", metadata,
    Column("id", Integer, primary_key=True),
    Column("store_id", Integer, nullable=False),
    Column("product_id", Integer, nullable=False),
    Column("created_day", Date, nullable=False),
    Column("snapshot", Text, nullable=False),
    Column("quantity", Integer, nullable=False),
    Column("status", String(16), nullable=False),
    Column("version", Integer, nullable=False),
    UniqueConstraint("store_id", "product_id", "created_day"),
)
decisions = Table(
    "reorder_decision", metadata,
    Column("id", Integer, primary_key=True),
    Column("draft_id", Integer, nullable=False, index=True),
    Column("store_id", Integer, nullable=False),
    Column("user_id", Integer, nullable=False),
    Column("action", String(16), nullable=False),
    Column("previous_quantity", Integer, nullable=False),
    Column("quantity", Integer, nullable=False),
    Column("note", String(240), nullable=False),
    Column("recorded_at", String(28), nullable=False),
)


class Decision(BaseModel):
    action: Literal["edit", "approve", "reject"]
    version: int = Field(ge=1)
    quantity: int | None = Field(default=None, ge=1, le=1_000_000)
    note: str = Field(default="", max_length=240)

class SupplierSettings(BaseModel):
    supplier: str = Field(min_length=1, max_length=100, pattern=r"\S")
    lead: int = Field(ge=1, le=60)


def lead_time_buffer(history: list[float], lead: int) -> tuple[int | None, int]:
    """Estimate variability from actual, non-overlapping lead-time totals."""
    if not 1 <= lead <= MAX_FORECAST_DAYS:
        return None, 0
    totals = sorted(sum(history[end - lead:end]) for end in range(len(history), lead - 1, -lead))
    if len(totals) < 10 or not any(totals):
        return None, len(totals)
    upper = totals[math.ceil(0.90 * len(totals)) - 1]
    return math.ceil(max(0, upper - median(totals))), len(totals)


def describe(engine, series: list[float], peers: list[list[float]], lead: int, today: date) -> dict:
    horizon = max(7, min(MAX_FORECAST_DAYS, lead))
    steps = engine.daily_quantiles(series, horizon)
    if steps is not None:
        method = "Chronos-Bolt (short context)" if len(series) < 28 else "Chronos-Bolt"
        values = list(steps)
    else:
        peer_rates = [mean(item[-28:]) for item in peers if len(item) >= 14 and any(item[-28:])]
        recent = series[-28:]
        if len(series) >= 28 and any(series):
            method, daily_rate = "28-day moving average", mean(recent)
        elif peer_rates:
            method, daily_rate = "Branch category fallback", median(peer_rates)
        elif any(recent):
            method, daily_rate = "Short sales history", mean(recent)
        else:
            method, daily_rate = "Insufficient data", None
        values = [(None, daily_rate, None)] * horizon
    rows = [
        {
            "date": (today + timedelta(days=offset)).isoformat(),
            "p10": None if low is None else round(low, 2),
            "p50": None if middle is None else round(middle, 2),
            "p90": None if high is None else round(high, 2),
        }
        for offset, (low, middle, high) in enumerate(values)
    ]
    medians = [middle for _, middle, _ in values]
    return {
        "method": method, "daily": rows,
        "daily_rate": mean(medians[:7]) if medians[0] is not None else None,
        "lead_demand": sum(medians[:lead]) if 1 <= lead <= len(medians) and medians[0] is not None else None,
    }


def recommendations(db, store_id, engine, seasonal_item, today):
    params = {"store": store_id, "start": today - timedelta(days=365), "today": today}
    products = list(db.execute(text(
        "SELECT p.product_id, p.product_name, p.product_barcode, p.product_category, p.product_date_added, "
        "p.season_start_month, p.season_end_month, p.supplier_lead_time_days, p.reorder_level, "
        "p.safety_stock_units, p.reorder_supplier, "
        "(SELECT COALESCE(SUM(b.quantity_remaining),0) FROM stock_batch b WHERE b.store_id=p.store_id "
        "AND b.product_id=p.product_id AND b.quantity_remaining>0 "
        "AND (b.expiry_date IS NULL OR b.expiry_date>=:today)) AS sellable "
        "FROM product p WHERE p.store_id=:store ORDER BY p.product_name, p.product_id"
    ), params).mappings())
    history = {}
    for row in db.execute(text(
        "SELECT product_id, DATE(sale_date) AS day, SUM(sale_quantity) AS qty FROM sales "
        "WHERE store_id=:store AND sale_date>=:start AND sale_date<:today GROUP BY product_id, DATE(sale_date)"
    ), params).mappings():
        history.setdefault(row["product_id"], {})[date.fromisoformat(str(row["day"])[:10])] = float(row["qty"])
    series_by_id = {}
    for product in products:
        product_id = product["product_id"]
        sold = history.get(product_id, {})
        added = date.fromisoformat(str(product["product_date_added"] or today)[:10])
        first = max(params["start"], min(added, min(sold, default=added)))
        series_by_id[product_id] = [sold.get(first + timedelta(days=i), 0) for i in range((today - first).days)]

    rows = []
    for product in products:
        pid = product["product_id"]
        stock, lead = int(product["sellable"]), int(product["supplier_lead_time_days"] or 0)
        season = product_season(product["season_start_month"], product["season_end_month"], today.month)
        peers = [
            series_by_id[p["product_id"]] for p in products
            if p["product_id"] != pid and p["product_category"] == product["product_category"]
            and product_season(p["season_start_month"], p["season_end_month"], today.month) != "off_season"
        ]
        series = series_by_id[pid]
        forecast = describe(engine, series, peers, lead, today)
        buffer, blocks = lead_time_buffer(series, lead)
        configured = int(product["safety_stock_units"] or 0)
        safety = max(configured, buffer or 0)
        demand = forecast["lead_demand"]
        reorder_point = None if demand is None else max(int(product["reorder_level"] or 0), math.ceil(demand + safety))
        suggested = max(0, reorder_point - stock) if reorder_point is not None else 0
        supplier = product["reorder_supplier"]
        reason = (
            f"Lead-time demand {demand:.1f} units, safety stock {safety}, sellable stock {stock}."
            if demand is not None else "Set a lead time of 1–60 days and collect sales history to estimate lead-time demand."
        )
        if buffer is None and demand is not None:
            reason += " Using configured safety stock because there are too few usable lead-time blocks."
        if season == "off_season":
            evidence = seasonal_item(db, store_id, pid).get("seasonal_evidence") or {}
            suggested = int(evidence.get("reorder_units") or 0) if evidence.get("order_due") and 1 <= lead <= MAX_FORECAST_DAYS else 0
            reason = "Off-season. " + (evidence.get("message") or "Waiting for the next order window.")
        if not supplier:
            reason += " Assign a supplier before creating a draft."
        daily_rate = forecast["daily_rate"]
        rows.append({
            "product_id": pid, "name": product["product_name"], "sku": product["product_barcode"],
            "supplier": supplier, "stock": stock, "lead": lead, "season": season,
            "method": forecast["method"], "daily": forecast["daily"], "history_days": len(series),
            "days_remaining": round(stock / daily_rate, 1) if daily_rate else None,
            "lead_demand": round(demand, 2) if demand is not None else None,
            "buffer_method": "Historical lead-time P90 minus median" if buffer is not None else "Configured safety stock",
            "sample_blocks": blocks, "safety": safety, "reorder_point": reorder_point,
            "quantity": min(1_000_000, suggested), "reason": reason,
        })
    return rows


def create_router(engine, seasonal_item):
    router = APIRouter(prefix="/api/reorder", tags=["reorder trial"])

    def owner(request, db, write=False):
        if write:
            require_csrf(request)
        user = current_user(request, db)
        require_owner(user)
        return user

    @router.get("")
    def worksheet(request: Request, db: Session = Depends(get_db)):
        user = owner(request, db)
        store = int(user["store_id"])
        today = date.today()
        store_name = db.execute(text("SELECT store_name FROM store WHERE store_id=:store"), {"store": store}).scalar_one_or_none()
        active = recommendations(db, store, engine, seasonal_item, today)
        saved = list(db.execute(drafts.select().where(drafts.c.store_id == store).order_by(drafts.c.id.desc()).limit(200)).mappings())
        audit = list(db.execute(decisions.select().where(decisions.c.store_id == store).order_by(decisions.c.id.desc()).limit(200)).mappings())
        return {
            "today": today, "store_id": store, "store_name": store_name, "recommendations": active,
            "drafts": [{**row, "snapshot": json.loads(row["snapshot"])} for row in saved],
            "decisions": [dict(row) for row in audit],
        }

    @router.post("/drafts")
    def generate(request: Request, db: Session = Depends(get_db)):
        user = owner(request, db, True)
        store = int(user["store_id"])
        today = date.today()
        products = recommendations(db, store, engine, seasonal_item, today)
        connection = db.connection()
        if connection.dialect.name == "sqlite":
            # SQLite's legacy transaction mode does not begin on SELECT. Keep
            # the nested inserts inside one explicit write transaction.
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        created = 0
        for product in products:
            if not product["quantity"] or not product["supplier"]:
                continue
            try:
                with db.begin_nested():
                    db.execute(drafts.insert().values(
                        store_id=store, product_id=product["product_id"], created_day=today,
                        snapshot=json.dumps(product), quantity=product["quantity"], status="pending", version=1,
                    ))
                created += 1
            except IntegrityError as error:
                # The store already has a draft for this SKU and forecast date.
                if connection.dialect.name in {"mysql", "mariadb"} and getattr(error.orig, "args", (None,))[0] == 1062:
                    continue
                existing = db.execute(drafts.select().where(
                    drafts.c.store_id == store, drafts.c.product_id == product["product_id"], drafts.c.created_day == today
                )).first()
                if not existing:
                    raise
        db.commit()
        return {"created": created}

    @router.put("/products/{product_id}/supplier")
    def set_supplier(product_id: int, payload: SupplierSettings, request: Request, db: Session = Depends(get_db)):
        user = owner(request, db, True)
        params = {"id": product_id, "store": int(user["store_id"]), "supplier": payload.supplier.strip(), "lead": payload.lead}
        result = db.execute(text(
            "UPDATE product SET reorder_supplier=:supplier, supplier_lead_time_days=:lead "
            "WHERE store_id=:store AND product_id=:id"
        ), params)
        if not result.rowcount:
            raise HTTPException(404, "Product not found in your store.")
        db.commit()
        return {"supplier": params["supplier"], "lead": payload.lead}

    @router.post("/drafts/{draft_id}/decision")
    def decide(draft_id: int, payload: Decision, request: Request, db: Session = Depends(get_db)):
        user = owner(request, db, True)
        store = int(user["store_id"])
        scope = (drafts.c.id == draft_id, drafts.c.store_id == store)
        row = db.execute(drafts.select().where(*scope)).mappings().first()
        if row is None:
            raise HTTPException(404, "Draft not found in your store.")
        if row["status"] != "pending" or row["version"] != payload.version:
            raise HTTPException(409, "The draft changed. Refresh the worksheet.")
        if (payload.action == "edit") != (payload.quantity is not None):
            raise HTTPException(422, "Supply a quantity only when editing a draft.")
        if payload.action in {"edit", "reject"} and not payload.note.strip():
            raise HTTPException(422, "Enter a reason for editing or rejecting this draft.")
        quantity = payload.quantity if payload.action == "edit" else row["quantity"]
        status = {"edit": "pending", "approve": "approved", "reject": "rejected"}[payload.action]
        result = db.execute(drafts.update().where(
            *scope, drafts.c.version == payload.version, drafts.c.status == "pending",
        ).values(quantity=quantity, status=status, version=payload.version + 1))
        if result.rowcount != 1:
            db.rollback()
            raise HTTPException(409, "The draft changed. Refresh the worksheet.")
        db.execute(decisions.insert().values(
            draft_id=draft_id, store_id=store, user_id=user["users_id"], action=payload.action,
            previous_quantity=row["quantity"], quantity=quantity, note=payload.note.strip(),
            recorded_at=datetime.now().isoformat(timespec="seconds"),
        ))
        db.commit()
        return {"status": status, "quantity": quantity, "version": payload.version + 1}

    return router
