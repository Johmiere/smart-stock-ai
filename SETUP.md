# Run SmartStock AI locally

Use Python 3.12 or newer. The demo runs on SQLite and creates its database, sample inventory, sales, and a local session key on first startup.

## Windows PowerShell

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts/run_reorder_trial.py
```

## macOS and Linux

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/run_reorder_trial.py
```

Open [Daily Digest](http://127.0.0.1:8005/daily-digest.html) and sign in with the local demo account `owner1@smartstock.invalid` and password `TrialStock!28`. The branded product names are examples. Sales, stock, prices, and suppliers are all synthetic.

The launcher binds to your computer only. Use `--port 8006` if another program already uses 8005. On port 8006, open the same path on that port.

## Optional AI services

- **Chronos-Bolt**. Install `requirements-ai.txt` in the same environment. Download the `amazon/chronos-bolt-small` model separately into `models/chronos-bolt-small`. A local folder set in `CHRONOS_MODEL` in `.env` also works. Start the demo with `--chronos` and check model readiness on **Reports & AI**. Without the model, forecasts use the existing moving-average baseline when enough history exists.
- **Groq tool selection**. Copy `.env.example` to `.env` and set your own `GROQ_API_KEY`. Start with `--groq-tool-routing`. The assistant uses local tools by default. Selecting **Ask via Groq for this question** sends that question to Groq to select a tool. The application queries the database and constructs the answer locally.

## Demo and verification

With the trial running on port 8005, run these commands from a second terminal using the same Python environment and repository:

```text
python scripts/showcase_trial.py
python scripts/prepare_branded_draft.py
python scripts/test_defense_trial.py -v
python scripts/verify_branded_trial.py
```

The first command adds optional extra grocery examples to Branch 1. The second saves a sample suggested purchase order for review. The last command runs sales, stock, and approval checks against a temporary database copy.

See [the defense trial walkthrough](DEFENSE-TRIAL.md) for sample SKUs, forecast evaluation, and the inventory policy simulation.

## Optional MariaDB setup

The included schema targets the XAMPP MariaDB demo database. The schema import recreates tables in `inventory_group_demo`. Use a fresh local database instance for this setup.

From a MariaDB client started in the repository folder, run the base schema and migrations in order:

```sql
SOURCE database/groupmate_clean_setup.sql;
SOURCE migrations/001_ssai_demo_extension.sql;
SOURCE migrations/002_sales_types.sql;
SOURCE migrations/003_product_maintenance.sql;
SOURCE migrations/004_sales_import_provenance.sql;
SOURCE migrations/005_sales_performance.sql;
SOURCE migrations/006_suggested_purchase_orders.sql;
```

Set `DATABASE_URL=mysql+pymysql://<account>:<password>@127.0.0.1:3306/inventory_group_demo?charset=utf8mb4` in your local `.env` using a database account with access to that database. Then run `python -m uvicorn app.main:app --host 127.0.0.1 --port 8006` and open [the sign-in page](http://127.0.0.1:8006/). Use **Create account** to register your local test store. The portable SQLite demo and its synthetic login are available through the separate trial launcher.
