from collections import defaultdict
from datetime import date, timedelta
from statistics import mean, pstdev
from time import perf_counter
import re

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.security import current_user, require_csrf, require_owner
from app.services.classification import product_season
from app.services.defense_groq import enabled as groq_enabled, select_tool
from app.services.inventory_backtest import compare


class Question(BaseModel):
    question: str = Field(min_length=2, max_length=400, pattern=r"\S")
    use_groq: bool = False


def stock_records(db, store, today):
    return [dict(row) for row in db.execute(text(
        "SELECT p.product_id, p.product_name, p.product_barcode, p.product_quantity, p.reorder_level, "
        "p.season_start_month, p.season_end_month, "
        "COUNT(b.batch_id) AS batch_count, COALESCE(SUM(b.quantity_remaining),0) AS batch_units, "
        "COALESCE(SUM(CASE WHEN b.expiry_date IS NULL OR b.expiry_date>=:today THEN b.quantity_remaining ELSE 0 END),0) AS sellable, "
        "COALESCE(SUM(CASE WHEN b.expiry_date<:today THEN b.quantity_remaining ELSE 0 END),0) AS expired, "
        "COALESCE(SUM(CASE WHEN b.expiry_date BETWEEN :today AND :soon THEN b.quantity_remaining ELSE 0 END),0) AS expiring, "
        "MIN(CASE WHEN b.expiry_date BETWEEN :today AND :soon THEN b.expiry_date END) AS due "
        "FROM product p LEFT JOIN stock_batch b ON p.product_id=b.product_id AND p.store_id=b.store_id "
        "AND b.quantity_remaining>0 WHERE p.store_id=:store "
        "GROUP BY p.product_id,p.product_name,p.product_barcode,p.product_quantity,p.reorder_level,"
        "p.season_start_month,p.season_end_month ORDER BY p.product_id"
    ), {"store": store, "today": today, "soon": today + timedelta(days=7)}).mappings()]


def source(row, table, href):
    return {"label": f"{table} · SKU {row['product_barcode']} · product #{row['product_id']}", "href": href}


def daily_actions(rows, today):
    actions = []
    for row in rows:
        name, sku = row["product_name"], row["product_barcode"]
        season = product_season(row["season_start_month"], row["season_end_month"], today.month)
        count, stock = int(row["product_quantity"] or 0), int(row["sellable"])
        if row["batch_count"] and count != int(row["batch_units"]):
            item = (0, "Reconcile stock count", f"Catalog shows {count} units. Active batches total {row['batch_units']}.", "product + stock_batch", "/stock-history.html")
        elif row["expired"]:
            item = (1, "Separate expired stock", f"{row['expired']} expired units remain in recorded batches.", "stock_batch", "/stock-history.html")
        elif stock == 0 and season != "off_season":
            item = (2, "Review stockout", "Sellable stock is zero. Check the purchase worksheet for a suggested quantity.", "product + stock_batch", "/reorder.html")
        elif row["expiring"]:
            item = (3, "Review a markdown or faster sell-through", f"{row['expiring']} units expire within seven days. Nearest date: {row['due']}.", "stock_batch", "/stock-history.html")
        elif stock <= int(row["reorder_level"] or 0) and season != "off_season" and row["reorder_level"]:
            item = (4, "Review reorder", f"{stock} sellable units against a configured reorder point of {row['reorder_level']}.", "product + stock_batch", "/reorder.html")
        else:
            continue
        rank, action, reason, table, href = item
        actions.append((rank, {"name": name, "sku": sku, "action": action, "reason": reason, "source": source(row, table, href)}))
    return [item for _, item in sorted(actions, key=lambda entry: entry[0])[:5]]


def observed_sales_profile(db, store, today):
    start = today - timedelta(days=84)
    dates = defaultdict(dict)
    products = db.execute(text(
        "SELECT product_id,product_name,product_barcode,product_price,product_date_added FROM product WHERE store_id=:store"
    ), {"store": store}).mappings().all()
    for row in db.execute(text(
        "SELECT product_id, DATE(sale_date) AS day, SUM(sale_quantity) AS units FROM sales "
        "WHERE store_id=:store AND sale_date>=:start AND sale_date<:today GROUP BY product_id, DATE(sale_date)"
    ), {"store": store, "start": start, "today": today}).mappings():
        dates[row["product_id"]][date.fromisoformat(str(row["day"])[:10])] = float(row["units"])
    output = []
    for product in products:
        pid = product["product_id"]
        first = max(start, date.fromisoformat(str(product["product_date_added"] or today)[:10]))
        if dates.get(pid):
            first = min(first, min(dates[pid]))
        samples = [dates[pid].get(first + timedelta(days=i), 0) for i in range((today - first).days)]
        price = float(product["product_price"] or 0)
        average = mean(samples) if samples else 0
        cv = pstdev(samples) / average if average else None
        zero_days = sum(value == 0 for value in samples)
        if len(samples) < 28:
            xyz, basis = "—", "Insufficient history"
        elif not average or zero_days >= len(samples) * .5 or cv > 1:
            xyz, basis = "Z", "Intermittent or variable · review weekly/category view"
        elif cv <= .5:
            xyz, basis = "X", "Stable · good candidate for daily evaluation"
        else:
            xyz, basis = "Y", "Variable · compare daily and weekly"
        output.append({
            "sku": product["product_barcode"], "name": product["product_name"], "days": len(samples),
            "zero_days": zero_days, "units": sum(samples), "value_proxy": round(sum(samples) * price, 2),
            "xyz": xyz, "profile": basis,
        })
    output.sort(key=lambda row: row["value_proxy"], reverse=True)
    total = sum(row["value_proxy"] for row in output)
    cumulative = 0
    for row in output:
        share = cumulative / total if total else 1
        row["abc"] = "C" if not row["value_proxy"] else "A" if share < .8 else "B" if share < .95 else "C"
        cumulative += row["value_proxy"]
    return {"start": start, "end": today - timedelta(days=1), "rows": output}


def answer_question(question, rows, today, tool_hint=None):
    question = question.casefold().strip()
    matches = [r for r in rows if any(re.search(r"(?<!\w)" + re.escape(str(value).casefold()) + r"(?!\w)", question)
               for value in (r["product_barcode"], r["product_name"]) if value)]
    if tool_hint == "expiry_records" or any(word in question for word in ("expire", "expir", "mapapanis", "panis")):
        tool = "expiry_records"
        choices = [r for r in (matches or rows) if r["expiring"] or r["expired"]]
        data = [(f"{r['product_name']}: {r['expired']} expired units, {r['expiring']} due within 7 days.", source(r, "stock_batch", "/stock-history.html")) for r in choices[:5]]
    elif tool_hint == "daily_actions" or any(word in question for word in ("order", "bilhin", "gagawin")):
        tool = "daily_actions"
        actions = daily_actions(matches or rows, today)
        if "order" in question or "bilhin" in question:
            actions = daily_actions([r for r in (matches or rows) if not r["expired"] and not r["expiring"]], today)
            actions = [r for r in actions if r["action"] in {"Review reorder", "Review stockout"}]
        data = [(f"{r['name']}: {r['action']}. {r['reason']}", r["source"]) for r in actions]
    elif matches and (tool_hint == "stock_by_sku" or any(word in question for word in ("stock", "ilan", "remaining", "supply", "natira"))):
        tool = "stock_by_sku"
        data = [(f"{r['product_name']}: {r['sellable']} sellable units as of {today}.",
                 source(r, "product + stock_batch", "/products.html")) for r in matches[:5]]
    else:
        tool, data = "unsupported_question", []
    # If a question names an unknown SKU, never answer using another product.
    if re.search(r"\b(?:ph|show|trial|demo)-[a-z0-9-]+\b", question) and not matches:
        data = []
    return {
        "tool": tool,
        "answer": " ".join(f"{line} [{i}]" for i, (line, _) in enumerate(data, 1))
        if data else "Wala akong nakitang record para sa tanong na ito. Subukan ang exact SKU, stock, expiry, o reorder.",
        "sources": [reference for _, reference in data],
    }


router = APIRouter(prefix="/api/defense", tags=["defense trial"])


@router.get("/digest")
def digest(request: Request, db: Session = Depends(get_db)):
    user = current_user(request, db)
    today = date.today()
    store = user["store_id"]
    label = db.execute(text("SELECT store_name FROM store WHERE store_id=:store"), {"store": store}).scalar_one()
    records = stock_records(db, store, today)
    return {
        "date": today, "store_name": label, "catalog_size": len(records),
        "actions": daily_actions(records, today), "groq_available": groq_enabled(),
    }


@router.get("/data-profile")
def data_profile(request: Request, db: Session = Depends(get_db)):
    require_owner(user := current_user(request, db))
    return observed_sales_profile(db, user["store_id"], date.today())


@router.get("/backtest")
def backtest(request: Request, promo_pct: int = Query(30, ge=0, le=150), db: Session = Depends(get_db)):
    require_owner(current_user(request, db))
    return compare(promo_pct)


@router.post("/ask")
def ask(payload: Question, request: Request, db: Session = Depends(get_db)):
    require_csrf(request)
    started = perf_counter()
    user = current_user(request, db)
    today = date.today()
    tool_hint = select_tool(payload.question) if payload.use_groq else None
    stock = stock_records(db, user["store_id"], today)
    query = payload.question.casefold()
    match = next((row for row in stock if re.search(
        r"(?<!\w)" + re.escape(row["product_barcode"].casefold()) + r"(?!\w)", query
    )), None)
    if ("forecast" in query or tool_hint == "forecast_evidence") and match:
        from app.main import get_ai_item
        evidence = get_ai_item(db, user["store_id"], match["product_id"])
        result = {
            "tool": "forecast_evidence",
            "answer": f"{evidence['product_name']}: {evidence['forecast_next_30_days']} estimated units across 30 days "
                      f"using {evidence['forecast_method']} with {evidence['history_days']} days of sales history. [1]",
            "sources": [source(match, "sales + product", f"/reports.html?product_id={match['product_id']}#decision")],
        }
    else:
        result = answer_question(payload.question, stock, today, tool_hint)
    provider = "Groq routing + local tools" if tool_hint else "local structured tools"
    return {**result, "latency_ms": round((perf_counter() - started) * 1000, 1), "provider": provider}
