"""Run the local POS and its phone-only HTTPS listener in one process."""

from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
from ipaddress import IPv4Address, AddressValueError
import os
from pathlib import Path
import socket
import ssl

from dotenv import load_dotenv
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send
import uvicorn


PHONE_PAGE_ASSETS = {
    "/phone-scanner.html",
    "/assets/css/phone-scanner.css",
    "/assets/js/phone-scanner.js",
    "/assets/js/vendor/zxing-browser.min.js",
}
PHONE_API = {"/api/scanner/phone/connect", "/api/scanner/phone/scans"}


def phone_only(application: ASGIApp) -> ASGIApp:
    async def scoped_app(scope: Scope, receive: Receive, send: Send) -> None:
        path = scope["path"]
        method = scope["method"]
        public_asset = method in {"GET", "HEAD"} and path in PHONE_PAGE_ASSETS
        authenticated_scan = method == "POST" and path in PHONE_API
        if scope.get("scheme") == "https" and (public_asset or authenticated_scan):
            await application(scope, receive, send)
        else:
            response = JSONResponse({"detail": "Phone scanner endpoint only."}, status_code=404)
            await response(scope, receive, send)

    return scoped_app


class PhoneServer(uvicorn.Server):
    @contextmanager
    def capture_signals(self):
        # The local POS server owns the shared process's signal handlers.
        yield


async def serve(local: uvicorn.Server, phone: uvicorn.Server, phone_socket: socket.socket) -> None:
    with local.config.bind_socket() as local_socket:
        tasks = {
            asyncio.create_task(local.serve(sockets=[local_socket])),
            asyncio.create_task(phone.serve(sockets=[phone_socket])),
        }
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            local.should_exit = True
            phone.should_exit = True
            await asyncio.gather(*tasks, return_exceptions=True)


def lan_address(value: str) -> str:
    try:
        address = IPv4Address(value)
    except AddressValueError as error:
        raise argparse.ArgumentTypeError("Enter the PC's private IPv4 address.") from error
    if not address.is_private or any(
        (address.is_loopback, address.is_unspecified, address.is_multicast, address.is_reserved)
    ):
        raise argparse.ArgumentTypeError("Enter the PC's private LAN IPv4 address.")
    return str(address)


def main() -> None:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lan-ip", type=lan_address, default=os.getenv("PHONE_SCANNER_LAN_IP") or None)
    parser.add_argument("--ssl-certfile", type=Path, default=os.getenv("PHONE_SCANNER_TLS_CERTFILE") or None)
    parser.add_argument("--ssl-keyfile", type=Path, default=os.getenv("PHONE_SCANNER_TLS_KEYFILE") or None)
    parser.add_argument("--pos-port", type=int, default=8000)
    parser.add_argument("--scanner-port", type=int, default=8443)
    args = parser.parse_args()
    if not all(1 <= port <= 65535 for port in (args.pos_port, args.scanner_port)):
        parser.error("Enter valid listener ports from 1 to 65535.")
    if not any((args.lan_ip, args.ssl_certfile, args.ssl_keyfile)):
        uvicorn.run("app.main:app", host="127.0.0.1", port=args.pos_port, proxy_headers=False)
        return
    if os.getenv("SESSION_HTTPS_ONLY", "").lower() == "true":
        parser.error("Use the main HTTPS deployment if SESSION_HTTPS_ONLY is enabled.")
    if not all((args.lan_ip, args.ssl_certfile, args.ssl_keyfile)):
        print("Phone scanner needs a LAN address, certificate, and key. Starting the local POS.", flush=True)
        uvicorn.run("app.main:app", host="127.0.0.1", port=args.pos_port, proxy_headers=False)
        return

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as phone_socket:
        try:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(args.ssl_certfile, args.ssl_keyfile)
            phone_socket.bind((args.lan_ip, args.scanner_port))
        except OSError:
            print("Phone scanner could not load its certificate or bind to Wi-Fi. Starting the local POS.", flush=True)
            uvicorn.run("app.main:app", host="127.0.0.1", port=args.pos_port, proxy_headers=False)
            return

        existing_hosts = os.getenv("APP_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")
        os.environ["APP_ALLOWED_HOSTS"] = f"{existing_hosts},{args.lan_ip}"
        os.environ["PHONE_SCANNER_ORIGIN"] = f"https://{args.lan_ip}:{args.scanner_port}"

        from app.main import app

        local = uvicorn.Server(uvicorn.Config(
            app, host="127.0.0.1", port=args.pos_port, proxy_headers=False,
        ))
        phone = PhoneServer(uvicorn.Config(
            phone_only(app), host=args.lan_ip, port=args.scanner_port,
            proxy_headers=False, lifespan="off", ws="none",
            ssl_certfile=str(args.ssl_certfile), ssl_keyfile=str(args.ssl_keyfile),
        ))
        asyncio.run(serve(local, phone, phone_socket))


if __name__ == "__main__":
    main()
