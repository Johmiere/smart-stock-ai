"""Launch a loopback-only copy of Smart Stock with synthetic branch data."""
import argparse
from contextlib import closing
from datetime import date, datetime, timedelta
from decimal import Decimal
import os
from pathlib import Path
import random
import secrets
import sqlite3
import sys

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models" / "chronos-bolt-small"
FIXTURE = ROOT / "reorder-trial.sqlite"
EMAILS = ["owner1@smartstock.invalid", "owner2@smartstock.invalid", "owner3@smartstock.invalid", "cashier1@smartstock.invalid",
          "owner4@smartstock.invalid"]
PASSWORD = "TrialStock!28"
SCHEMA = """
CREATE TABLE store (store_id INTEGER PRIMARY KEY, store_name TEXT, store_location TEXT);
CREATE TABLE province (prov_id INTEGER PRIMARY KEY, prov_name TEXT);
CREATE TABLE municipality (mun_id INTEGER PRIMARY KEY, mun_name TEXT, prov_id INT);
CREATE TABLE barangay (brgy_id INTEGER PRIMARY KEY, brgy_name TEXT, mun_id INT);
CREATE TABLE users (users_id INTEGER PRIMARY KEY, store_id INT, users_role TEXT, users_fname TEXT,
 users_mname TEXT, users_lname TEXT, users_sname TEXT, barangay_id INT);
CREATE TABLE credential (cre_id INTEGER PRIMARY KEY, users_id INT, cre_username TEXT UNIQUE, cre_password TEXT, cre_status INT);
CREATE TABLE product (product_id INTEGER PRIMARY KEY, store_id INT, product_name TEXT, product_barcode TEXT,
 product_quantity INT, product_date_added DATE, product_category TEXT, product_unit TEXT, product_price NUMERIC,
 reorder_level INT, supplier_lead_time_days INT, safety_stock_units INT, product_projected_price NUMERIC,
 season_start_month INT, season_end_month INT, product_unit_cost NUMERIC, reorder_supplier TEXT,
 UNIQUE(store_id, product_barcode));
CREATE TABLE stock_batch (batch_id INTEGER PRIMARY KEY, product_id INT, store_id INT, quantity_received INT,
 quantity_remaining INT, expiry_date DATE, received_at DATETIME, notes TEXT, created_by INT);
CREATE TABLE stock_movement (movement_id INTEGER PRIMARY KEY, product_id INT, store_id INT, users_id INT,
 movement_type TEXT, quantity INT, previous_quantity INT, new_quantity INT, notes TEXT,
 batch_id INT, sales_id INT, movement_date DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sales (sales_id INTEGER PRIMARY KEY, store_id INT, product_id INT, sale_quantity INT, sale_date DATETIME,
 sale_transaction_id INT, sale_unit_price NUMERIC, sale_discount_amount NUMERIC, sale_type TEXT,
 import_batch_id INT, import_line_key TEXT, sale_unit_cost NUMERIC, UNIQUE(store_id, import_line_key));
CREATE INDEX sales_history ON sales(store_id, sale_date, product_id);
CREATE TABLE sale_transaction (transaction_id INTEGER PRIMARY KEY, store_id INT, users_id INT,
 subtotal NUMERIC, discount_type TEXT, discount_reference TEXT, discount_amount NUMERIC, total_amount NUMERIC,
 created_at DATETIME, checkout_id TEXT, checkout_fingerprint TEXT, UNIQUE(store_id, checkout_id));
CREATE TABLE sales_import_batch (batch_id INTEGER PRIMARY KEY, store_id INT, imported_by INT, source_type TEXT,
 source_label TEXT, file_sha256 TEXT, imported_rows INT, duplicate_rows INT, skipped_rows INT, period_start DATE,
 period_end DATE, unique_products INT, units INT, imported_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(store_id,file_sha256));
INSERT INTO province VALUES (1,'Trial Province');
INSERT INTO municipality VALUES (1,'Trial Municipality',1);
INSERT INTO barangay VALUES (1,'Trial Barangay',1);
"""


def configure(database):
    sys.path.insert(0, str(ROOT))
    session_secret = secrets.token_urlsafe(48)
    if database.resolve() == FIXTURE.resolve():
        # Keep browser sign-in across future trial restarts.
        session_file = ROOT / ".trial-session-key"
        try:
            with session_file.open("x", encoding="ascii") as handle:
                handle.write(session_secret)
        except FileExistsError:
            session_secret = session_file.read_text(encoding="ascii").strip()
        if len(session_secret) < 32:
            raise RuntimeError("The trial session key must contain at least 32 characters.")
    os.environ.update(
        DATABASE_URL="sqlite:///" + database.as_posix(),
        SESSION_SECRET=session_secret,
        SESSION_HTTPS_ONLY="false", APP_ALLOWED_HOSTS="localhost,127.0.0.1",
        CHRONOS_ENABLED="true", CHRONOS_MODEL=os.getenv("CHRONOS_MODEL", str(MODEL)),
        CHRONOS_DEVICE=os.getenv("CHRONOS_DEVICE", "cpu"),
        LLM_PROVIDER="none", GROQ_API_KEY="", GROQ_INVENTORY_CONTEXT="false",
        HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
    )
    sqlite3.register_adapter(Decimal, str)
    sqlite3.register_adapter(date, date.isoformat)
    sqlite3.register_adapter(datetime, lambda value: value.isoformat(sep=" "))


def seed(database, today, password_hash):
    rng = random.Random(96041)
    start = today - timedelta(days=365)
    off_month = (today.month + 5) % 12 + 1
    items = [
        ("Sardines 155 g", "Pantry", 7, 5, 6, 365, None),
        ("Instant noodles", "Pantry", 9, 2, 4, 365, None),
        ("New tuna flakes", "Pantry", 0, 2, 4, 0, None),
        ("Bottled water 500 mL", "Drinks", 11, 6, 3, 365, None),
        ("Fruit juice 250 mL", "Drinks", 4, 2, 3, 12, None),
        ("Seasonal snack box", "Seasonal", 0, 2, 6, 365, off_month),
    ]
    with closing(sqlite3.connect(database)) as db, db:
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store'").fetchone():
            if not db.execute("SELECT 1 FROM store WHERE store_name='Trial Grocery · Branch 1'").fetchone():
                raise RuntimeError("Refusing to use a database without the synthetic trial marker.")
            return
        db.executescript("BEGIN IMMEDIATE;\n" + SCHEMA)
        for branch in range(1, 4):
            db.execute("INSERT INTO store VALUES (?,?,?)", (branch, f"Trial Grocery · Branch {branch}", "Synthetic branch"))
            db.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?,?)", (branch, branch, "owner", "Trial", None, f"Owner {branch}", None, 1))
            db.execute("INSERT INTO credential VALUES (?,?,?,?,?)", (branch, branch, EMAILS[branch - 1], password_hash, 1))
            for index, (name, category, rate, stock, lead, days, season) in enumerate(items, 1):
                pid = (branch - 1) * len(items) + index
                barcode = f"TRIAL-{index:03d}"
                supplier = "Sample Grocery Supply" if category != "Drinks" else "Sample Beverage Supply"
                first_sale = today - timedelta(days=days)
                db.execute(
                    "INSERT INTO product VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (pid, branch, name, barcode, stock, first_sale, category, "pieces", 35,
                     3, lead, 2, None, season, season, 20, supplier),
                )
                db.execute(
                    "INSERT INTO stock_batch VALUES (NULL,?,?,?,?,?,?,?,?)",
                    (pid, branch, stock, stock, today + timedelta(days=60), today, "Synthetic opening stock", branch),
                )
                for offset in range(days):
                    day = first_sale + timedelta(days=offset)
                    base = rate * (0.85 + branch * 0.12) if season is None else (10 if day.month == season else 0)
                    weekend = 1.20 if day.weekday() >= 5 else 1
                    payday = 1.18 if day.day in {15, 30, 31} else 1
                    holiday = 1.20 if day.month == 12 and day.day >= 15 else 1
                    promotion = 1.35 if index in {1, 2} and (day - start).days % 60 in {16, 17, 18} else 1
                    inventory_limit = 0 if (day - start).days % 53 == 31 else 50
                    qty = max(0, min(inventory_limit, round(base * weekend * payday * holiday * promotion + (rng.uniform(-2, 2) if base else 0))))
                    if qty:
                        db.execute(
                            "INSERT INTO sales (store_id,product_id,sale_quantity,sale_date,sale_unit_price,"
                            "sale_discount_amount,sale_type) VALUES (?,?,?,?,?,?,?)",
                            (branch, pid, qty, day.isoformat() + " 12:00:00", 0, 0, "seasonal" if season else "general"),
                        )
        db.execute("INSERT INTO users VALUES (4,1,'clerk','Trial',NULL,'Cashier',NULL,1)")
        db.execute("INSERT INTO credential VALUES (4,4,?,?,1)", (EMAILS[3], password_hash))
        db.execute("INSERT INTO store VALUES (4,'Trial Grocery · Branch 4','Synthetic branch')")
        db.execute("INSERT INTO users VALUES (5,4,'owner','Trial',NULL,'Owner 4',NULL,1)")
        db.execute("INSERT INTO credential VALUES (5,5,?,?,1)", (EMAILS[4], password_hash))
        from scripts.seed_branded_catalog import seed_store
        for branch in (1, 4):
            seed_store(db, branch, today)


def build(database=FIXTURE, *, chronos=True, groq_routing=False):
    load_dotenv(ROOT / ".env")
    groq_key = os.getenv("GROQ_API_KEY", "") if groq_routing else ""
    configure(database)
    os.environ["GROQ_API_KEY"] = groq_key
    os.environ["DEFENSE_GROQ_ROUTE"] = str(bool(groq_key)).lower()
    if not chronos:
        os.environ["CHRONOS_ENABLED"] = "false"
    from app.database import engine
    from app.security import hash_password
    from app.services.reorder import metadata
    from app.main import app
    from starlette.middleware.sessions import SessionMiddleware
    seed(database, date.today(), hash_password(PASSWORD))
    metadata.create_all(engine)
    middleware = next(item for item in app.user_middleware if item.cls is SessionMiddleware)
    middleware.kwargs["session_cookie"] = "smart_stock_defense_trial"
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8005)
    parser.add_argument("--chronos", action="store_true", help="Load local Chronos weights for the trial.")
    parser.add_argument("--groq-tool-routing", action="store_true", help="Send trial questions to Groq for tool selection when GROQ_API_KEY is set.")
    options = parser.parse_args()
    import uvicorn
    uvicorn.run(build(chronos=options.chronos, groq_routing=options.groq_tool_routing),
                host="127.0.0.1", port=options.port, proxy_headers=False, access_log=False)
