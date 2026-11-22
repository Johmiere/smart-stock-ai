# SmartStock AI

SmartStock AI is a grocery inventory and point-of-sale application for Philippine stores. This repository contains the English interface and FastAPI backend from the local demo on port 8005.

- **POS and inventory** support barcode entry, PC camera scanning, receipts, stock adjustments, and batch expiry tracking.
- **Sales and stock reports** show seasonal and general sales, margins, stock movement, and low-stock alerts.
- **Purchase planning** combines demand forecasts, lead times, and supplier settings with a draft review workflow.
- **Daily Digest and AI Assistant** show prioritized actions and answer questions from store records with citations. Chronos-Bolt and Groq are optional.

To run the app from a fresh checkout, follow [local setup](SETUP.md). The local SQLite demo creates its own synthetic grocery data. See the [defense walkthrough](DEFENSE-TRIAL.md) and [design system](DESIGN-SYSTEM.md) for examples.

| Path | Contents |
| --- | --- |
| `app/` | FastAPI routes, business logic, and responsive web UI |
| `database/` | Clean MySQL bootstrap for a separate local integration |
| `migrations/` | Database schema changes |
| `scripts/` | Demo launcher, data generation, and verification |
