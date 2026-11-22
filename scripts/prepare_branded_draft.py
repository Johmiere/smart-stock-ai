"""Save one pending branded suggestion and leave the remaining SKUs for review."""
from datetime import date
import json
import os

import httpx
from sqlalchemy import text

from run_reorder_trial import FIXTURE, configure


with httpx.Client(base_url="http://127.0.0.1:8005", timeout=8, trust_env=False) as client:
    response = client.get("/api/auth/csrf").raise_for_status()
    assert "smart_stock_defense_trial=" in response.headers["set-cookie"]
configure(FIXTURE)
os.environ["CHRONOS_ENABLED"] = "false"
from app.database import SessionLocal
from app.main import forecast_engine, get_ai_item
from app.services.reorder import drafts, recommendations

with SessionLocal() as db:
    assert db.execute(text("SELECT store_name FROM store WHERE store_id=1")).scalar_one() == "Trial Grocery · Branch 1"
    for store in (4, 1):
        today = date.today()
        rows = recommendations(db, store, forecast_engine, get_ai_item, today)
        active = [row for row in rows if row["sku"].startswith("PH-") and row["quantity"] > 0 and row["supplier"]]
        assert any(row["sku"] == "PH-555-SARD" for row in active)
        reserved = next(row for row in active if row["sku"] == "PH-LM-CANTON")
        existing = db.execute(drafts.select().where(
            drafts.c.store_id == store, drafts.c.product_id == reserved["product_id"], drafts.c.created_day == today,
        )).mappings().first()
        if existing is None:
            result = db.execute(drafts.insert().values(
                store_id=store, product_id=reserved["product_id"], created_day=today,
                snapshot=json.dumps(reserved), quantity=reserved["quantity"], status="pending", version=1,
            ))
            db.commit()
            print(f"Store {store}: posted pending demo draft #{result.inserted_primary_key[0]} for Lucky Me! Pancit Canton.")
        else:
            print(f"Store {store}: existing Lucky Me! draft #{existing['id']} retained.")
        print(f"Store {store}: {len(active)} branded SKUs currently eligible for reorder review.")
