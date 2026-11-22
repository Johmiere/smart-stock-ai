from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import date, datetime
from hashlib import sha256
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from sqlalchemy import bindparam, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.security import current_user, require_csrf, require_owner
from app.services.classification import is_in_season

router = APIRouter(prefix="/api/imports/sales", tags=["sales history"])
SourceType = Literal["partner_pos", "public_benchmark", "test_data", "unspecified"]
PREVIEW_SOURCES = {"public_benchmark", "test_data"}
CSV_HEADER = "date,barcode,qty_sold,source_line_id\r\n"
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ROWS = 50_000
BARCODE = re.compile(r"[A-Za-z0-9_-]{3,50}")
SOURCE_ID = re.compile(r"[A-Za-z0-9_.:-]{1,120}")
BATCH_FIELDS = (
    "batch_id, source_type, source_label, imported_rows, duplicate_rows, "
    "skipped_rows, period_start, period_end, unique_products, units, file_sha256, imported_at"
)
INSERT_SALE = text(
    "INSERT INTO sales (store_id, product_id, sale_quantity, sale_date, "
    "sale_unit_price, sale_discount_amount, sale_type, import_batch_id, import_line_key) "
    "VALUES (:store_id, :product_id, :quantity, :sale_time, 0, 0, :sale_type, :batch_id, :line_key)"
)


@dataclass(frozen=True)
class SalesRow:
    line: int
    sale_time: datetime
    barcode: str
    quantity: int
    source_line_id: str


def parse_row(line: int, row: dict[str, str | None], today: date) -> SalesRow:
    date_text = (row["date"] or "").strip()
    try:
        sale_time = datetime.fromisoformat(date_text.replace("Z", "+00:00"))
        if sale_time.tzinfo is not None:
            sale_time = sale_time.astimezone().replace(tzinfo=None)
    except (ValueError, OverflowError) as exc:
        raise ValueError("Use YYYY-MM-DD or an ISO 8601 sale timestamp.") from exc
    if not date(1970, 1, 2) <= sale_time.date() <= today:
        raise ValueError("Use a historical sale date from 1970-01-02 through today.")
    barcode = (row["barcode"] or "").strip()
    if not BARCODE.fullmatch(barcode):
        raise ValueError("Use the barcode text from the product catalog, including leading zeros.")
    quantity = (row["qty_sold"] or "").strip()
    if not quantity.isascii() or not quantity.isdecimal() or len(quantity) > 7 or not 1 <= int(quantity) <= 1_000_000:
        raise ValueError("Enter a whole quantity from 1 to 1,000,000.")
    source_line_id = (row.get("source_line_id") or "").strip()
    if source_line_id and not SOURCE_ID.fullmatch(source_line_id):
        raise ValueError("Use an anonymous source line ID with letters, numbers, dots, dashes, underscores, or colons.")
    return SalesRow(line, sale_time.replace(microsecond=0), barcode, int(quantity), source_line_id)


def parse_file(raw: bytes) -> tuple[list[SalesRow], list[dict]]:
    try:
        decoded = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(400, "Use a UTF-8 CSV file.") from exc
    reader = csv.DictReader(io.StringIO(decoded, newline=""), strict=True)
    accepted = []
    errors = []
    today = date.today()
    try:
        fields = [name.strip().lower() for name in (reader.fieldnames or [])]
        if len(set(fields)) != len(fields) or not {"date", "barcode", "qty_sold"}.issubset(fields):
            raise HTTPException(400, "Use unique headers and include date, barcode, and qty_sold.")
        reader.fieldnames = fields
        for record_count, row in enumerate(reader, start=1):
            if record_count > MAX_ROWS:
                raise HTTPException(413, f"Include at most {MAX_ROWS:,} rows per file.")
            try:
                if None in row:
                    raise ValueError("The row has more values than the header.")
                accepted.append(parse_row(reader.line_num, row, today))
            except ValueError as exc:
                errors.append({"line": reader.line_num, "error": str(exc)})
    except csv.Error as exc:
        raise HTTPException(400, f"Malformed CSV near line {reader.line_num}.") from exc
    return accepted, errors


def query_keys(db: Session, sql: str, store_id: int, keys: set[str]) -> list[dict]:
    query = text(sql).bindparams(bindparam("keys", expanding=True))
    values = sorted(keys)
    return [
        dict(row)
        for offset in range(0, len(values), 500)
        for row in db.execute(query, {"store_id": store_id, "keys": values[offset : offset + 500]}).mappings()
    ]


def import_rows(
    db: Session, store_id: int, source_type: SourceType, label: str, parsed: list[SalesRow], errors: list[dict]
) -> tuple[list[dict], int]:
    products = {
        row["product_barcode"].lower(): row
        for row in query_keys(
            db,
            "SELECT product_barcode, product_id, season_start_month, season_end_month FROM product "
            "WHERE store_id=:store_id AND LOWER(product_barcode) IN :keys",
            store_id,
            {row.barcode.lower() for row in parsed},
        )
    }
    existing = {}
    line_keys = {
        row.source_line_id: sha256(f"{source_type}\0{label.casefold()}\0{row.source_line_id}".encode()).hexdigest()
        for row in parsed
        if row.source_line_id
    }
    if source_type not in PREVIEW_SOURCES:
        existing = {
            row["import_line_key"]: row
            for row in query_keys(
                db,
                "SELECT import_line_key, product_id, sale_date AS sale_time, sale_quantity AS quantity "
                "FROM sales WHERE store_id=:store_id AND import_line_key IN :keys",
                store_id,
                set(line_keys.values()),
            )
        }

    candidates = []
    seen = {}
    conflicts = set()
    duplicate_count = 0
    for row in parsed:
        product = products.get(row.barcode.lower())
        if product is None:
            errors.append({"line": row.line, "error": "The barcode is missing from this store's product catalog."})
            continue
        key = line_keys.get(row.source_line_id)
        record = {
            "line": row.line,
            "store_id": store_id,
            "product_id": int(product["product_id"]),
            "sale_time": row.sale_time,
            "quantity": row.quantity,
            "sale_type": "seasonal" if is_in_season(
                product["season_start_month"], product["season_end_month"], row.sale_time.month
            ) else "general",
            "line_key": key,
        }
        if key and (prior := existing.get(key) or seen.get(key)) is not None:
            prior_time = prior["sale_time"]
            if isinstance(prior_time, str):
                prior_time = datetime.fromisoformat(prior_time)
            prior_values = (prior["product_id"], prior_time, prior["quantity"])
            if prior_values == (record["product_id"], row.sale_time, row.quantity):
                duplicate_count += 1
            else:
                if key in seen:
                    conflicts.add(key)
                errors.append({"line": row.line, "error": "The same source line ID has different sale details."})
            continue
        if key:
            seen[key] = record
        candidates.append(record)
    errors.extend(
        {"line": row["line"], "error": "Another row in this file uses this source line ID with different sale details."}
        for row in candidates if row["line_key"] in conflicts
    )
    return [row for row in candidates if row["line_key"] not in conflicts], duplicate_count


@router.get("")
def list_imports(request: Request, db: Session = Depends(get_db)) -> dict:
    user = current_user(request, db)
    require_owner(user)
    batches = db.execute(
        text(f"SELECT {BATCH_FIELDS} FROM sales_import_batch WHERE store_id=:store_id "
             "ORDER BY batch_id DESC LIMIT 50"),
        {"store_id": int(user["store_id"])},
    ).mappings()
    return {"batches": [dict(batch) for batch in batches]}


@router.get("/template")
def import_template(request: Request, db: Session = Depends(get_db)) -> Response:
    require_owner(current_user(request, db))
    return Response(
        content=CSV_HEADER, media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="smart-stock-sales-template.csv"'},
    )


@router.post("")
def import_sales(
    request: Request,
    file: Annotated[UploadFile, File()],
    source_type: Annotated[SourceType, Form()] = "unspecified",
    source_label: Annotated[str, Form(max_length=120)] = "",
    preview_only: Annotated[bool, Form()] = False,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_csrf(request)
    user = current_user(request, db)
    require_owner(user)
    store_id = int(user["store_id"])
    source_label = " ".join(source_label.split())
    if source_type != "unspecified" and not source_label:
        raise HTTPException(422, "Enter a name for this data source.")
    if not preview_only and source_type in PREVIEW_SOURCES:
        raise HTTPException(422, "Use Preview for benchmark and test files. This prevents mixing them with store sales.")

    raw = file.file.read(MAX_FILE_BYTES + 1)
    if len(raw) > MAX_FILE_BYTES:
        raise HTTPException(413, "Use a CSV file no larger than 5 MB.")
    file_checksum = sha256(raw).hexdigest()
    existing = db.execute(
        text(f"SELECT {BATCH_FIELDS} FROM sales_import_batch WHERE store_id=:store_id AND file_sha256=:checksum"),
        {"store_id": store_id, "checksum": file_checksum},
    ).mappings().first()
    if existing and source_type not in PREVIEW_SOURCES:
        return {
            "batch_id": existing["batch_id"], "preview_only": preview_only,
            "imported_rows": 0, "valid_rows": 0, "errors": [], "duplicate_rows": existing["imported_rows"] + existing["duplicate_rows"],
            "skipped_rows": existing["skipped_rows"], "period_start": existing["period_start"],
            "period_end": existing["period_end"], "units": 0, "unique_products": 0,
            "note": "This exact file is already in the store history. No rows were added.",
        }

    parsed, errors = parse_file(raw)
    records, duplicate_count = import_rows(db, store_id, source_type, source_label, parsed, errors)
    errors.sort(key=lambda item: item["line"])
    days = [row["sale_time"].date() for row in records]
    summary = {
        "period_start": min(days, default=None), "period_end": max(days, default=None),
        "unique_products": len({row["product_id"] for row in records}),
        "units": sum(row["quantity"] for row in records),
        "skipped_rows": len(errors), "duplicate_rows": duplicate_count,
    }
    batch_id = None
    if records and not preview_only:
        try:
            batch = db.execute(text(
                "INSERT INTO sales_import_batch (store_id, imported_by, source_type, source_label, file_sha256, "
                "imported_rows, duplicate_rows, skipped_rows, period_start, period_end, unique_products, units) "
                "VALUES (:store_id, :imported_by, :source_type, :source_label, :checksum, "
                ":imported_rows, :duplicate_rows, :skipped_rows, :period_start, :period_end, :unique_products, :units)"
            ), {
                **summary, "store_id": store_id, "imported_by": int(user["users_id"]), "source_type": source_type,
                "source_label": source_label or None, "checksum": file_checksum, "imported_rows": len(records),
            })
            batch_id = int(batch.lastrowid)
            for offset in range(0, len(records), 500):
                db.execute(INSERT_SALE, [{**row, "batch_id": batch_id} for row in records[offset : offset + 500]])
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(409, "The catalog or import history changed. Preview the file again before importing.") from exc
    return {
        **summary, "batch_id": batch_id, "preview_only": preview_only, "valid_rows": len(records),
        "imported_rows": 0 if preview_only else len(records), "errors": errors[:100],
        "note": "Preview complete. No records were added." if preview_only else
        "Historical quantities add sales evidence. They leave current stock, prices, and POS receipts alone.",
    }
