"""Add a reproducible branded grocery showroom to the isolated 8005 database."""
import argparse
from contextlib import closing
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from math import ceil
import sqlite3
from random import Random
from uuid import NAMESPACE_URL, uuid5

import httpx


CENT = Decimal("0.01")
HISTORY_DAYS = 84
SEED = 221106


@dataclass(frozen=True)
class Item:
    sku: str
    name: str
    category: str
    price: int
    cost: int
    demand: float
    lead: int
    shelf_life: int = 150
    seasonal: str = ""
    example: str = ""


CATALOG = (
    Item("LM-CANTON", "Lucky Me! Pancit Canton", "Noodles", 19, 15, 9, 3, example="low"),
    Item("LM-CHICKEN", "Lucky Me! Chicken Mami", "Noodles", 14, 11, 7, 3),
    Item("SKYFLAKES", "SkyFlakes Crackers", "Snacks", 11, 8, 7, 4),
    Item("FITA", "Fita Crackers", "Snacks", 12, 9, 2, 4),
    Item("CENTURY", "Century Tuna Flakes in Oil 155 g", "Canned Goods", 54, 41, 5, 4),
    Item("555-SARD", "555 Sardines in Tomato Sauce 155 g", "Canned Goods", 27, 21, 6, 3, example="out"),
    Item("ARGENTINA", "Argentina Corned Beef 150 g", "Canned Goods", 44, 34, 4, 5),
    Item("FRESCA", "Fresca Tuna Flakes", "Canned Goods", 33, 25, 2, 5),
    Item("MILO", "MILO Chocolate Malt Powder", "Beverages", 14, 10, 8, 3, example="checkout"),
    Item("CHUCKIE", "Nestlé Chuckie Chocolate Milk", "Beverages", 24, 18, 5, 2, 38, example="near"),
    Item("BEAR", "Bear Brand Fortified Powdered Milk Drink", "Dairy", 18, 14, 5, 3),
    Item("NESCAFE", "NESCAFÉ 3-in-1 Original", "Beverages", 13, 10, 9, 3),
    Item("CREAM", "Nestlé All Purpose Cream", "Dairy", 89, 70, 4, 4, seasonal="active", example="low"),
    Item("MAGGI", "MAGGI Magic Sarap", "Seasonings", 8, 6, 6, 3),
    Item("PIATTOS", "Jack 'n Jill Piattos", "Snacks", 24, 18, 6, 3),
    Item("NOVA", "Jack 'n Jill Nova", "Snacks", 24, 17, 3, 4),
    Item("CREAMO", "Cream-O Chocolate Cookies", "Snacks", 15, 14, 5, 4, example="promo"),
    Item("C2-APPLE", "C2 Apple Green Tea", "Beverages", 23, 17, 5, 3, 65),
    Item("GT-WHITE", "Great Taste White Coffee", "Beverages", 11, 8, 7, 3),
    Item("DATUPUTI", "Datu Puti Soy Sauce", "Condiments", 28, 21, 2, 5),
    Item("UFC", "UFC Banana Catsup", "Condiments", 30, 24, 2, 5, example="new"),
    Item("DM-PASTA", "Del Monte Filipino Style Spaghetti Sauce", "Condiments", 64, 49, 3, 4),
    Item("DM-FIESTA", "Del Monte Fiesta Fruit Cocktail", "Canned Goods", 109, 83, 3, 5, seasonal="off", example="off"),
    Item("DM-CHUNKS", "Del Monte Pineapple Chunks 200 g", "Canned Goods", 48, 36, 3, 4, 100, example="expired"),
)


@dataclass
class Batch:
    id: int
    until: date
    units: int


@dataclass
class Product:
    id: int
    item: Item
    start: date
    season: int | None
    batches: list[Batch] = field(default_factory=list)

    @property
    def stock(self):
        return sum(batch.units for batch in self.batches)


def amount(value):
    return format(Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP), "f")


def stamp(day, time="12:30:00"):
    return f"{day.isoformat()} {time}"


def movement(db, p, store, actor, day, kind, units, before, note, batch_id, sale_id=None):
    db.execute(
        "INSERT INTO stock_movement (product_id,store_id,users_id,movement_type,quantity,"
        "previous_quantity,new_quantity,notes,batch_id,sales_id,movement_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (p.id, store, actor, kind, units, before, p.stock, note, batch_id, sale_id, stamp(day)),
    )


def receive(db, p, store, actor, day, until, units):
    before = p.stock
    batch_id = db.execute(
        "INSERT INTO stock_batch (product_id,store_id,quantity_received,quantity_remaining,expiry_date,received_at,notes,created_by) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (p.id, store, units, units, until.isoformat(), stamp(day, "08:00:00"), "Synthetic branded grocery delivery", actor),
    ).lastrowid
    p.batches.append(Batch(batch_id, until, units))
    movement(db, p, store, actor, day, "add", units, before, "Synthetic branded grocery delivery", batch_id)


def reduce_batch(db, p, batch, store, actor, day, units, note, sale_id=None):
    before = p.stock
    batch.units -= units
    db.execute("UPDATE stock_batch SET quantity_remaining=? WHERE batch_id=?", (batch.units, batch.id))
    movement(db, p, store, actor, day, "reduce", units, before, note, batch.id, sale_id)


def seed_store(db, store, today):
    existing = db.execute("SELECT COUNT(*) FROM product WHERE store_id=? AND product_barcode LIKE 'PH-%'", (store,)).fetchone()[0]
    if existing:
        if existing != len(CATALOG):
            raise RuntimeError("Demo SKU prefix is already in use. Existing products were kept intact.")
        print(f"Store {store}: branded catalog already exists.")
        return
    assert db.execute("SELECT 1 FROM users WHERE store_id=? AND users_role='owner'", (store,)).fetchone()
    actor = db.execute("INSERT INTO users (store_id,users_role,users_fname,users_lname,barangay_id) VALUES "
                       "(?,'clerk','Demo','Grocery Operator',1)", (store,)).lastrowid
    start = today - timedelta(days=HISTORY_DAYS)
    rng = Random(SEED + store)
    products = []
    for item in CATALOG:
        first = today if item.example == "new" else start
        season = today.month if item.seasonal == "active" else (today.month + 5) % 12 + 1 if item.seasonal == "off" else None
        product_id = db.execute(
            "INSERT INTO product (store_id,product_name,product_barcode,product_quantity,product_date_added,"
            "product_category,product_unit,product_price,reorder_level,supplier_lead_time_days,safety_stock_units,"
            "season_start_month,season_end_month,product_unit_cost,reorder_supplier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (store, item.name, "PH-" + item.sku, 0, first.isoformat(), item.category, "pieces", item.price,
             ceil(item.demand * item.lead), item.lead, 2, season, season, item.cost, "Demo Grocery Distributor"),
        ).lastrowid
        products.append(Product(product_id, item, first, season))

    receipt_count = stockout_days = zero_days = 0
    for offset in range(HISTORY_DAYS):
        day = start + timedelta(days=offset)
        basket = []
        for index, product in enumerate(products):
            item = product.item
            if day < product.start:
                continue
            for batch in product.batches:
                if batch.units and batch.until < day:
                    reduce_batch(db, product, batch, store, actor, day, batch.units, "Synthetic expiry write-off")
            if offset == 0 or (offset + index) % 8 == 0 and (offset + index) % 24 != 16:
                size = max(3, round(item.demand * rng.uniform(6, 10)))
                receive(db, product, store, actor, day, day + timedelta(days=item.shelf_life), size)
            promo = item.example == "promo" and day.day in {5, 6, 15, 16, 25, 26}
            rate = item.demand * (1.23 if day.weekday() >= 5 else 1) * (1.18 if day.day in {15, 30, 31} else 1)
            if product.season is not None and day.month != product.season:
                rate *= .24
            if promo:
                rate *= 2.4
            latent = 0 if item.demand <= 3 and rng.random() < .38 else max(0, round(rate + rng.uniform(-1.5, 1.5)))
            recorded = min(product.stock, latent)
            zero_days += recorded == 0
            stockout_days += recorded < latent
            if recorded:
                discount = Decimal(recorded * item.price) * Decimal("0.20") if promo else Decimal(0)
                basket.append((product, recorded, discount))
        if not basket:
            continue
        subtotal = sum(p.item.price * units for p, units, _ in basket)
        discount = sum((value for _, _, value in basket), Decimal(0))
        checkout = str(uuid5(NAMESPACE_URL, f"smartstock-branded-8005:{store}:{day}"))
        receipt = db.execute(
            "INSERT INTO sale_transaction (store_id,users_id,subtotal,discount_type,discount_reference,discount_amount,"
            "total_amount,created_at,checkout_id) VALUES (?,?,?,?,?,?,?,?,?)",
            (store, actor, subtotal, "none", "Synthetic promo" if discount else None,
             amount(discount), amount(Decimal(subtotal) - discount), stamp(day), checkout),
        ).lastrowid
        receipt_count += 1
        for product, quantity, discount in basket:
            item = product.item
            kind = "seasonal" if product.season == day.month else "general"
            sale_id = db.execute(
                "INSERT INTO sales (store_id,product_id,sale_quantity,sale_date,sale_transaction_id,"
                "sale_unit_price,sale_discount_amount,sale_type,sale_unit_cost) VALUES (?,?,?,?,?,?,?,?,?)",
                (store, product.id, quantity, stamp(day), receipt, item.price, amount(discount), kind, item.cost),
            ).lastrowid
            remaining = quantity
            for batch in sorted(product.batches, key=lambda row: (row.until, row.id)):
                if not remaining:
                    break
                take = min(remaining, batch.units)
                if take:
                    reduce_batch(db, product, batch, store, actor, day, take, f"Synthetic sale #{receipt}", sale_id)
                    remaining -= take
            assert remaining == 0

    expired_example = next(p for p in products if p.item.example == "expired")
    yesterday = today - timedelta(days=1)
    receive(db, expired_example, store, actor, yesterday, yesterday, 6)
    expired_batch = expired_example.batches[-1].id
    scenarios = {"out": (0, 30), "low": (3, 45), "checkout": (42, 50), "near": (18, 2),
                 "off": (12, 130), "expired": (0, 0), "new": (3, 75)}
    for product in products:
        example = scenarios.get(product.item.example)
        if example is not None:
            for batch in product.batches:
                if batch.units and batch.id != expired_batch:
                    reduce_batch(db, product, batch, store, actor, today, batch.units, "Synthetic inventory count correction")
            units, days_remaining = example
            if units:
                receive(db, product, store, actor, today, today + timedelta(days=days_remaining), units)
        db.execute("UPDATE product SET product_quantity=? WHERE product_id=? AND store_id=?", (product.stock, product.id, store))
    print(f"Store {store}: {len(products)} branded products, {receipt_count} synthetic POS receipts, "
          f"{stockout_days} censored SKU-days and {zero_days} zero-selling SKU-days.")


def main():
    from run_reorder_trial import FIXTURE

    parser = argparse.ArgumentParser()
    parser.add_argument("stores", nargs="+", type=int)
    args = parser.parse_args()
    if not FIXTURE.is_file() or not all(store > 0 for store in args.stores):
        raise SystemExit("The defense trial database is missing or the destination store is invalid.")
    with httpx.Client(base_url="http://127.0.0.1:8005", timeout=8, trust_env=False) as client:
        csrf = client.get("/api/auth/csrf").raise_for_status()
        assert "smart_stock_defense_trial=" in csrf.headers["set-cookie"]
        assert client.get("/daily-digest.html").status_code == 200
    with closing(sqlite3.connect(FIXTURE, timeout=10)) as db:
        assert db.execute("SELECT store_name FROM store WHERE store_id=1").fetchone()[0] == "Trial Grocery · Branch 1"
        backup = FIXTURE.with_name(f"before-branded-{datetime.now():%Y%m%d-%H%M%S-%f}.sqlite")
        with closing(sqlite3.connect(backup)) as saved:
            db.backup(saved)
        with db:
            db.execute("BEGIN IMMEDIATE")
            for store in dict.fromkeys(args.stores):
                seed_store(db, store, date.today())
        print(f"Trial backup: {backup.name}")


if __name__ == "__main__":
    main()
