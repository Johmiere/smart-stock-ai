from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from hashlib import sha256
from ipaddress import ip_address
from math import ceil
import os
import re
import secrets
from threading import Lock
from time import monotonic
from typing import Annotated
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, StringConstraints, ValidationError
from sqlalchemy.orm import Session

from app.database import get_db
from app.security import current_user, require_csrf

router = APIRouter(prefix="/api/scanner", tags=["Phone scanner"])
PHONE_SCANNER_ORIGIN = os.getenv("PHONE_SCANNER_ORIGIN", "").strip()
JOIN_SECONDS = 300
SESSION_SECONDS = 3600
MAX_PAIRINGS = 64
MAX_PER_BROWSER = 4
MAX_PENDING = 32
MAX_SCAN_IDS = 2048
MIN_SCAN_INTERVAL = 0.1
MAX_BODY_BYTES = 512
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")
POSBrowser = tuple[int, int, str]


class ScanSubmission(BaseModel):
    barcode: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=50,
                                               pattern=r"^[A-Za-z0-9_-]{3,50}$")]
    scan_id: UUID


@dataclass
class Pairing:
    id: str
    token_digest: bytes
    owner: POSBrowser
    expires_at: float
    phone_connected: bool = False
    sequence: int = 0
    last_scan_at: float = float("-inf")
    pending: deque[tuple[int, str]] = field(default_factory=deque)
    replay: dict[UUID, tuple[int, str]] = field(default_factory=dict)


class Pairings:
    """Store short-lived scan events in the same process as the POS worker."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._by_id: dict[str, Pairing] = {}
        self._by_token: dict[bytes, Pairing] = {}

    def _remove(self, pair: Pairing) -> None:
        del self._by_id[pair.id]
        del self._by_token[pair.token_digest]

    def _active(self, pair: Pairing | None, now: float) -> Pairing:
        if pair is not None:
            if pair.expires_at > now:
                return pair
            self._remove(pair)
        raise HTTPException(404, detail="This phone pairing has ended. Start a new pairing on the POS.")

    def _owned(self, pairing_id: str, owner: POSBrowser, now: float) -> Pairing:
        pair = self._by_id.get(pairing_id)
        if pair is not None and pair.owner != owner:
            pair = None
        return self._active(pair, now)

    def create(self, owner: POSBrowser) -> tuple[str, str]:
        with self._lock:
            now = monotonic()
            for pair in list(self._by_id.values()):
                if pair.expires_at <= now:
                    self._remove(pair)
            if len(self._by_id) >= MAX_PAIRINGS or sum(
                pair.owner == owner for pair in self._by_id.values()
            ) >= MAX_PER_BROWSER:
                raise HTTPException(429, detail="Too many active phone pairings. Close a pairing and try again.")
            token = secrets.token_urlsafe(32)
            digest = sha256(token.encode("ascii")).digest()
            pair = Pairing(secrets.token_urlsafe(24), digest, owner, now + JOIN_SECONDS)
            self._by_id[pair.id] = pair
            self._by_token[digest] = pair
            return pair.id, token

    def poll(self, pairing_id: str, owner: POSBrowser, after: int) -> dict:
        with self._lock:
            now = monotonic()
            pair = self._owned(pairing_id, owner, now)
            if after > pair.sequence:
                raise HTTPException(400, detail="The scan cursor is ahead of this pairing.")
            while pair.pending and pair.pending[0][0] <= after:
                pair.pending.popleft()
            return {
                "scans": [{"id": sequence, "barcode": barcode} for sequence, barcode in pair.pending],
                "phone_connected": pair.phone_connected,
                "expires_in": ceil(pair.expires_at - now),
            }

    def close(self, pairing_id: str, owner: POSBrowser) -> None:
        with self._lock:
            self._remove(self._owned(pairing_id, owner, monotonic()))

    def close_browser(self, browser: str) -> None:
        with self._lock:
            for pair in list(self._by_id.values()):
                if pair.owner[2] == browser:
                    self._remove(pair)

    def connect(self, token_digest: bytes) -> int:
        with self._lock:
            now = monotonic()
            pair = self._active(self._by_token.get(token_digest), now)
            if not pair.phone_connected:
                pair.phone_connected = True
                pair.expires_at = now + SESSION_SECONDS
            return ceil(pair.expires_at - now)

    def is_connected(self, token_digest: bytes) -> None:
        with self._lock:
            pair = self._active(self._by_token.get(token_digest), monotonic())
            if not pair.phone_connected:
                raise HTTPException(409, detail="Connect the phone scanner before sending barcodes.")

    def submit(self, token_digest: bytes, scan: ScanSubmission) -> int:
        with self._lock:
            now = monotonic()
            pair = self._active(self._by_token.get(token_digest), now)
            existing = pair.replay.get(scan.scan_id)
            if existing is not None:
                sequence, barcode = existing
                if barcode != scan.barcode:
                    raise HTTPException(409, detail="This scan ID already belongs to a different barcode.")
                return sequence
            if len(pair.replay) >= MAX_SCAN_IDS:
                raise HTTPException(410, detail="This phone pairing has reached its scan limit. Start a new pairing.")
            if len(pair.pending) >= MAX_PENDING or now - pair.last_scan_at < MIN_SCAN_INTERVAL:
                raise HTTPException(429, detail="The checkout is busy. Retry this scan shortly.", headers={"Retry-After": "1"})
            pair.sequence += 1
            pair.last_scan_at = now
            event = (pair.sequence, scan.barcode)
            pair.pending.append(event)
            pair.replay[scan.scan_id] = event
            return pair.sequence


pairings = Pairings()


def loopback(host: str | None) -> bool:
    if not host:
        return False
    host = host.rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def phone_origin(request: Request) -> str:
    source = PHONE_SCANNER_ORIGIN or str(request.base_url)
    try:
        url = urlsplit(source)
        host = url.hostname
        port = url.port
        if host and port != 0 and url.scheme == "https" and not loopback(host) and (
            host not in {"0.0.0.0", "::"} and url.username is None and url.password is None
            and url.path in {"", "/"} and not url.query and not url.fragment
            and not any(char.isspace() or char == "\\" for char in url.netloc)
        ):
            return f"https://{url.netloc}"
    except ValueError:
        pass
    raise HTTPException(409, detail="Start Smart Stock with a phone-accessible HTTPS address before pairing a phone.")


def pos_browser(request: Request, db: Session) -> POSBrowser:
    if request.url.scheme != "https" and not (
        loopback(request.url.hostname) and request.client and loopback(request.client.host)
    ):
        raise HTTPException(400, detail="Use HTTPS or open the POS on this computer to pair a phone.")
    user = current_user(request, db)
    browser = request.session.get("csrf_token")
    if not browser:
        raise HTTPException(403, detail="Refresh the POS and start a new pairing.")
    return (int(user["store_id"]), int(user["users_id"]), browser)


def phone_token_digest(request: Request) -> bytes:
    if request.url.scheme != "https":
        raise HTTPException(400, detail="Open the phone scanner using HTTPS.")
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not TOKEN_PATTERN.fullmatch(token):
        raise HTTPException(401, detail="Open the pairing link from the POS first.")
    return sha256(token.encode("ascii")).digest()


@router.post("/pairings")
def pair_phone(request: Request, db: Session = Depends(get_db)) -> dict:
    require_csrf(request)
    owner = pos_browser(request, db)
    origin = phone_origin(request)
    pairing_id, token = pairings.create(owner)
    return {"pairing_id": pairing_id, "phone_url": f"{origin}/phone-scanner.html#token={token}",
            "expires_in": JOIN_SECONDS}


@router.get("/pairings/{pairing_id}")
def poll_phone(
    pairing_id: str, request: Request, after: Annotated[int, Query(ge=0)] = 0, db: Session = Depends(get_db)
) -> dict:
    return pairings.poll(pairing_id, pos_browser(request, db), after)


@router.delete("/pairings/{pairing_id}")
def close_phone(pairing_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    require_csrf(request)
    pairings.close(pairing_id, pos_browser(request, db))
    return {"closed": True}


@router.post("/phone/connect")
def connect_phone(request: Request) -> dict:
    return {"expires_in": pairings.connect(phone_token_digest(request))}


@router.post("/phone/scans")
async def submit_phone_scan(request: Request) -> dict:
    digest = phone_token_digest(request)
    pairings.is_connected(digest)
    payload = bytearray()
    async for chunk in request.stream():
        if len(payload) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, detail="The barcode request is too large.")
        payload.extend(chunk)
    try:
        scan = ScanSubmission.model_validate_json(payload)
    except ValidationError as exc:
        raise HTTPException(422, detail="Send a valid product barcode and scan ID.") from exc
    return {"id": pairings.submit(digest, scan)}
