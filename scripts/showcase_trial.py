"""Populate and verify Branch 1 of the loopback-only synthetic trial."""
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path
import sqlite3
from uuid import NAMESPACE_URL, uuid5

import httpx

from run_reorder_trial import EMAILS, FIXTURE, PASSWORD


PRODUCTS = [
    ("Jasmine Rice 1 kg", "Pantry", 125, 65, 51, 15, 4, 140),
    ("Pancit Canton Calamansi", "Pantry", 96, 18, 13, 16, 2, 100),
    ("Sweet Soy Sauce 350 mL", "Pantry", 51, 38, 27, 10, 4, 180),
    ("Canned Corned Beef 150 g", "Pantry", 68, 48, 37, 12, 5, 210),
    ("Cooking Oil 1 L", "Pantry", 53, 115, 93, 8, 3, 200),
    ("Fresh Pandesal Pack", "Bakery", 22, 39, 26, 8, 1, 2),
    ("Whole Wheat Bread", "Bakery", 16, 72, 51, 5, 2, 4),
    ("Eggs 6-Pack", "Fresh", 34, 69, 50, 7, 2, 9),
    ("Fresh Milk 1 L", "Drinks", 41, 97, 73, 12, 3, 6),
    ("Calamansi Juice 350 mL", "Drinks", 79, 32, 20, 14, 3, 86),
    ("Coconut Water 330 mL", "Drinks", 83, 40, 30, 12, 4, 76),
    ("3-in-1 Coffee 10-Pack", "Pantry", 62, 81, 62, 13, 3, 168),
    ("Laundry Detergent Refill", "Household", 70, 63, 47, 8, 4, None),
    ("Dishwashing Liquid 500 mL", "Household", 28, 65, 44, 7, 4, None),
    ("Holiday Pasta Set", "Seasonal", 4, 179, 133, 8, 5, 160),
    ("Summer Cooler Bundle", "Seasonal", 20, 105, 76, 6, 4, 140),
    ("Instant Oatmeal 300 g", "Pantry", 0, 75, 52, 8, 3, None),
    ("Cocoa Wafer Promo Pack", "Pantry", 85, 32, "31.50", 10, 2, 75),
]
RECEIPT_OFFSETS = (0, 2, 4, 6, 8, 11, 13, 15, 18, 21, 24, 27, 30, 35, 43, 49)


def main():
    today = date.today()
    base = "http://127.0.0.1:8005"
    with closing(sqlite3.connect(FIXTURE, timeout=10)) as db, httpx.Client(base_url=base, timeout=75, trust_env=False) as client:
        marker = db.execute("SELECT store_name FROM store WHERE store_id=1").fetchone()
        assert marker == ("Trial Grocery · Branch 1",), "Expected the dedicated trial SQLite database"

        def get(path, **kwargs):
            return client.get(path, **kwargs).raise_for_status().json()

        initial_token = get("/api/auth/csrf")["csrf_token"]
        response = client.post("/api/auth/login", headers={"X-CSRF-Token": initial_token}, json={"email": EMAILS[0], "password": PASSWORD})
        response.raise_for_status()
        assert any(cookie.name == "smart_stock_defense_trial" for cookie in client.cookies.jar)
        assert get("/api/auth/me")["store_id"] == 1
        assert get("/api/dashboard/summary")["store_name"] == marker[0]
        headers = {"X-CSRF-Token": get("/api/auth/csrf")["csrf_token"]}

        def write(method, path, body=None):
            response = client.request(method, path, headers=headers, json=body)
            if response.is_error:
                raise RuntimeError(f"{method} {path}: {response.status_code} {response.text}")
            return response.json()

        existing = {row["product_barcode"]: row for row in get("/api/products")}
        ids = {}
        for index, (name, category, units, price, cost, minimum, lead, expiry_days) in enumerate(PRODUCTS, 1):
            code = f"SHOW-{index:03}"
            if code not in existing:
                month = today.month if index == 15 else (today.month + 5) % 12 + 1 if index == 16 else None
                created = write("POST", "/api/products", {
                    "product_name": name, "product_barcode": code, "product_quantity": units, "price": price,
                    "unit_cost": cost, "reorder_level": minimum, "supplier_lead_time_days": lead,
                    "safety_stock_units": 3, "category": category, "unit": "pieces",
                    "season_start_month": month, "season_end_month": month,
                    "expiry_date": (today + timedelta(days=expiry_days)).isoformat() if expiry_days is not None else None,
                })
                ids[index] = created["product_id"]
            else:
                ids[index] = existing[code]["product_id"]
            supplier = "Sample Dry Goods" if category in {"Pantry", "Household", "Seasonal"} else "Sample Fresh & Beverage"
            write("PUT", f"/api/reorder/products/{ids[index]}/supplier", {"supplier": supplier, "lead": lead})
        write("PATCH", f"/api/products/{ids[1]}/maintenance", {"projected_price": "67.50"})
        rice = get("/api/products/lookup", params={"barcode": "SHOW-001"})
        assert rice["product_id"] == ids[1]

        if not db.execute("SELECT 1 FROM stock_movement WHERE store_id=1 AND notes=?",
                          ("Showcase supplier delivery",)).fetchone():
            write("POST", f"/api/products/{ids[8]}/stock-adjustments",
                  {"action": "increase", "quantity": 12, "notes": "Showcase supplier delivery",
                   "expiry_date": (today + timedelta(days=17)).isoformat()})
        if not db.execute("SELECT 1 FROM stock_movement WHERE store_id=1 AND notes=?",
                          ("Showcase damaged packaging",)).fetchone():
            write("POST", f"/api/products/{ids[13]}/stock-adjustments",
                  {"action": "decrease", "quantity": 2, "notes": "Showcase damaged packaging"})

        for index, offset in enumerate(RECEIPT_OFFSETS):
            checkout = str(uuid5(NAMESPACE_URL, f"smart-stock-priority-one-showcase-receipt-{index}"))
            if db.execute("SELECT 1 FROM sale_transaction WHERE store_id=1 AND checkout_id=?", (checkout,)).fetchone():
                continue
            sale_day = today - timedelta(days=offset)
            items = [{"barcode": f"SHOW-{sku:03}", "quantity": qty}
                     for sku, qty in [(1 + index % 5, 1 + index % 3),
                                      (9 + index % 4, 1 + index % 2), (18, 2)]]
            if index == 0:
                items.extend([{"barcode": "SHOW-015", "quantity": 1}, {"barcode": "SHOW-008", "quantity": 1}])
            body = {"checkout_id": checkout, "items": items, "discount_type": "senior" if index % 4 == 0 else "none"}
            receipt = write("POST", "/api/sales", body)
            retry = write("POST", "/api/sales", body)
            assert receipt["transaction_id"] == retry["transaction_id"]
            # Stage synthetic reporting dates on trial receipts made through the
            # normal checkout path. Keep line, receipt and movement dates aligned.
            stamp = sale_day.isoformat() + " 10:30:00"
            transaction = receipt["transaction_id"]
            with db:
                db.execute("UPDATE sale_transaction SET created_at=? WHERE store_id=1 AND transaction_id=? AND checkout_id=?",
                           (stamp, transaction, checkout))
                db.execute("UPDATE sales SET sale_date=? WHERE store_id=1 AND sale_transaction_id=?", (stamp, transaction))
                db.execute("UPDATE stock_movement SET movement_date=? WHERE store_id=1 AND sales_id IN "
                           "(SELECT sales_id FROM sales WHERE store_id=1 AND sale_transaction_id=?)", (stamp, transaction))

        performance = get("/api/sales/performance")
        assert performance["current"]["sale_lines"] and performance["previous"]["sale_lines"]
        assert performance["current"]["gross_profit"] is not None
        assert performance["previous"]["gross_profit"] is not None
        assert performance["loss_products"], "Expected the discounted wafer demonstration"
        assert get("/api/sales", params={"sale_type": "seasonal"})
        assert get("/api/stock/movements", params={"movement_type": "reduce"})["total"] > 0

        forecast = get("/api/reorder")
        assert any(row["lead_demand"] is not None for row in forecast["recommendations"])
        assert any(row["method"] == "Branch category fallback" for row in forecast["recommendations"])
        assert next(row for row in forecast["recommendations"] if row["sku"] == "SHOW-016")["quantity"] == 0
        write("POST", "/api/reorder/drafts")
        forecast = get("/api/reorder")
        if not forecast["decisions"]:
            pending = [row for row in forecast["drafts"] if row["status"] == "pending"]
            assert len(pending) >= 4
            edit, approve, reject = pending[:3]
            write("POST", f"/api/reorder/drafts/{edit['id']}/decision", {
                "action": "edit", "version": edit["version"], "quantity": edit["quantity"] + 2, "note": "Showcase supplier minimum",
            })
            write("POST", f"/api/reorder/drafts/{approve['id']}/decision", {
                "action": "approve", "version": approve["version"], "note": "Showcase buyer review",
            })
            write("POST", f"/api/reorder/drafts/{reject['id']}/decision", {
                "action": "reject", "version": reject["version"], "note": "Showcase supplier unavailable",
            })
        forecast = get("/api/reorder")
        assert {"edit", "approve", "reject"} <= {row["action"] for row in forecast["decisions"]}
        assert any(row["status"] == "pending" for row in forecast["drafts"])

        detail = get("/api/ai/items/1")
        export = client.post("/api/imports/sales", headers=headers,
                             data={"source_type": "test_data", "source_label": "Synthetic showroom preview", "preview_only": "true"},
                             files={"file": ("showcase.csv", "date,barcode,qty_sold,source_line_id\r\n"
                                                f"{today - timedelta(days=1)},SHOW-001,2,showcase-preview\r\n", "text/csv")})
        export.raise_for_status()
        evaluation = get("/api/ai/evaluation", params={"product_id": 1})
        assert len(evaluation["results"]) >= 3
        assistant = write("POST", "/api/assistant/ask", {"question": "Why is TRIAL-006 off-season?"})
        assert assistant["data_used"]["items"] and assistant["answer"]
        assert get("/api/users")
        for page in ("dashboard", "products", "sales", "stock-history", "low-stock", "reports", "reorder", "users"):
            client.get(f"/{page}.html").raise_for_status()

        cart_count = db.execute("SELECT COUNT(*) FROM sale_transaction WHERE store_id=1").fetchone()[0]
        catalog = get("/api/products")
        print(f"{len(catalog)} products; {cart_count} POS receipts; {len(forecast['drafts'])} purchase drafts; "
              f"{len(forecast['decisions'])} logged decisions.")
        print(f"Current 28 days: sales {performance['current']['revenue']}; gross profit {performance['current']['gross_profit']}.")
        print(f"Previous 28 days: sales {performance['previous']['revenue']}; gross profit {performance['previous']['gross_profit']}.")
        print(f"Chronos: {detail['forecast_method']}; assistant: {assistant['provider']}; "
              f"evaluation models: {len(evaluation['results'])}; CSV preview status: {export.status_code}.")


if __name__ == "__main__":
    main()
