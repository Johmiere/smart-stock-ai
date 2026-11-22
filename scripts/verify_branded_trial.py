"""Exercise the branded showcase in a disposable copy using normal app endpoints."""
import argparse
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from uuid import uuid4

from fastapi.testclient import TestClient

from run_reorder_trial import FIXTURE, PASSWORD, build


def check(enable_chronos):
    with TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        copied = Path(directory) / "branded-qa.sqlite"
        with closing(sqlite3.connect(FIXTURE)) as source, closing(sqlite3.connect(copied)) as target:
            source.backup(target)
        application = build(copied, chronos=enable_chronos)
        from app.database import engine
        from app.security import hash_password

        try:
            with closing(sqlite3.connect(copied)) as db, db:
                verify_email = "branded-qa@smartstock.invalid"
                db.execute(
                    "UPDATE credential SET cre_username=?,cre_password=? WHERE users_id=(SELECT MIN(users_id) "
                    "FROM users WHERE store_id=4 AND users_role='owner')", (verify_email, hash_password(PASSWORD)),
                )
                # Free a forecast day for one known stockout in the test copy.
                # The real review queue may already have been generated in the browser.
                db.execute(
                    "UPDATE reorder_draft SET created_day=? WHERE store_id=4 AND created_day=? AND product_id IN "
                    "(SELECT product_id FROM product WHERE store_id=4 AND product_barcode='PH-555-SARD')",
                    ("2000-01-01", date.today().isoformat()),
                )
            with TestClient(application, base_url="http://127.0.0.1") as client:
                def get(path, **kwargs):
                    return client.get(path, **kwargs).raise_for_status().json()

                def csrf():
                    return {"X-CSRF-Token": get("/api/auth/csrf")["csrf_token"]}

                def write(method, path, data, expected=200):
                    response = client.request(method, path, headers=csrf(), json=data)
                    assert response.status_code == expected, (path, response.text)
                    return response.json()

                write("POST", "/api/auth/login", {"email": verify_email, "password": PASSWORD})
                assert get("/api/auth/me")["store_id"] == 4
                items = {row["product_barcode"]: row for row in get("/api/products")}
                assert len(items) == get("/api/dashboard/summary")["products_count"] == 24
                assert all(code.startswith("PH-") for code in items)
                assert get("/api/stock/movements")["total"] > 1_000
                assert get("/api/sales", params={"sale_type": "seasonal"})
                assert get("/api/sales", params={"sale_type": "general"})
                assert get("/api/sales/best-sellers")
                report = get("/api/sales/performance")
                assert float(report["current"]["gross_profit"]) > 0
                assert float(report["previous"]["gross_profit"]) > 0
                assert any(item["barcode"] == "PH-CREAMO" for item in report["loss_products"]), report["loss_products"]
                statuses = {row["barcode"]: row for row in get("/api/ai/items")["items"]}
                assert statuses["PH-555-SARD"]["sellable_stock"] == 0
                assert statuses["PH-CHUCKIE"]["expiry_status"] == "watch"
                assert statuses["PH-DM-CHUNKS"]["expiry_status"] == "expired"
                assert statuses["PH-DM-FIESTA"]["sale_season"] == "off_season"
                ai = get("/api/ai/status")
                if enable_chronos:
                    assert ai["chronos"]["status"] == "ready", ai
                evaluation = get("/api/ai/evaluation", params={"product_id": items["PH-MILO"]["product_id"]})
                assert len(evaluation["results"]) >= 3
                assert len(get("/api/defense/data-profile")["rows"]) == 24
                assert len(get("/api/defense/digest")["actions"]) == 5
                assert get("/api/defense/backtest?promo_pct=50")["promo_pct"] == 50
                answer = write("POST", "/api/defense/ask", {"question": "Ilan ang stock ng PH-MILO?"})
                assert answer["tool"] == "stock_by_sku" and answer["sources"]
                assert not write("POST", "/api/defense/ask", {"question": "Ilan ang stock ng PH-MISSING?"})["sources"]
                forecast = write("POST", "/api/defense/ask", {"question": "Bakit ganito ang forecast ng PH-MILO?"})
                assert forecast["tool"] == "forecast_evidence" and forecast["sources"]
                if enable_chronos:
                    assert "chronos-bolt" in forecast["answer"]
                upload = client.post("/api/imports/sales", headers=csrf(),
                    data={"source_type":"test_data","source_label":"Branded fixture CSV","preview_only":"true"},
                    files={"file": ("demo.csv", f"date,barcode,qty_sold,source_line_id\r\n{date.today()},PH-MILO,2,branded-qa-01\r\n", "text/csv")})
                upload.raise_for_status()
                assert upload.json().get("valid_rows") == 1, upload.json()

                orders = get("/api/reorder")
                assert any(row["snapshot"]["sku"] == "PH-LM-CANTON" for row in orders["drafts"])
                created = write("POST", "/api/reorder/drafts", None)
                assert created["created"] > 0
                assert write("POST", "/api/reorder/drafts", None)["created"] == 0
                pending = [row for row in get("/api/reorder")["drafts"] if row["status"] == "pending"]
                first, second = pending[:2]
                route = f"/api/reorder/drafts/{first['id']}/decision"
                write("POST", route, {"action": "edit", "version": first["version"], "quantity": first["quantity"]+1, "note": "Fixture review"})
                write("POST", route, {"action": "approve", "version": first["version"]+1})
                write("POST", f"/api/reorder/drafts/{second['id']}/decision",
                      {"action":"reject","version":second["version"],"note":"Fixture review"})
                assert {"edit", "approve", "reject"} <= {row["action"] for row in get("/api/reorder")["decisions"]}

                milo = items["PH-MILO"]["product_id"]
                write("PATCH", f"/api/products/{milo}/maintenance", {"projected_price": "15.00"})
                write("POST", f"/api/products/{milo}/stock-adjustments",
                      {"action":"increase","quantity":8,"expiry_date":(date.today()+timedelta(days=7)).isoformat(),
                       "notes":"Branded FEFO test"})
                sale = {"checkout_id":str(uuid4()), "items":[{"barcode":"PH-MILO","quantity":3}]}
                receipt = write("POST", "/api/sales", sale)
                assert write("POST", "/api/sales", sale)["transaction_id"] == receipt["transaction_id"]
                write("POST", "/api/sales", {"checkout_id":str(uuid4()),"items":[{"barcode":"PH-DM-CHUNKS","quantity":1}]}, 409)
                with closing(sqlite3.connect(copied)) as db:
                    balance = db.execute("SELECT quantity_remaining FROM stock_batch WHERE product_id=? AND notes=?",
                                         (milo, "Branded FEFO test")).fetchone()
                    assert balance == (5,), balance
                print(f"Branded workflows passed. Chronos {ai['chronos']['status']}. Created and reviewed {created['created']} drafts in test copy.")
        finally:
            engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--chronos", action="store_true")
    check(parser.parse_args().chronos)
