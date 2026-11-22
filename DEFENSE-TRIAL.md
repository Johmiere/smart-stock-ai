# Smart Stock defense trial

Open `http://127.0.0.1:8005/daily-digest.html`. Sign in with `owner1@smartstock.invalid` and the synthetic trial password `TrialStock!28`.

## Five-minute demo

1. Open **Daily Digest**. Review the stockout and near-expiry rows and follow a source link.
2. Expand **Sales data and ABC–XYZ profile**. Explain recorded zero-sales days, the selling-price value proxy, and how the XYZ flags can guide evaluation granularity. The profile gives review guidance.
3. Run the **What-if and peso impact** simulation at 30% promo lift and then try 85%. Compare fixed, adaptive, and the adaptive policy with future promo uplift removed. Export per-SKU results as a CSV.
4. Ask **How much stock is available for PH-MILO?**, then **How much stock is available for PH-MISSING?**. Show the source and measured request latency for the first and the no-record response for the second. Try **Why was this forecast made for PH-MILO?** to see the forecast method and coverage.
5. Summarize the limitations and show the established **Suggested Purchase Orders** flow in the main app.

## Reproducible baseline

Seed 4107 uses three fictional SKUs, 56 days of observed training sales per SKU, and an 84-day holdout. The simulator knows latent demand. It exposes only recorded past sales and available lead-time information to the policies. It models shared variable lead times, expiry with FEFO, promo spikes, intermittent demand, and a demand shift. It demonstrates censored sales by capping training sales on some days.

The fixed rule reviews every three days and uses a fixed rate fit on the same training period. The adaptive rule updates its recent rate from uncensored non-promo observations when available, uses a historical upper lead-time percentile, and considers shelf life and scheduled promotions. The ablation removes the forward promo adjustment. The price, cost, and holding assumptions are part of the fixture.

At 30% promo lift, modeled cost was **₱7,742.00 fixed** and **₱2,636.32 adaptive**, a difference of **₱5,105.68**. Stockouts occurred on **75 vs. 32 SKU-days**. Neither the peso difference nor the 57% reduction in stockout SKU-days represents observed store savings.

## Branded grocery examples

The 24 product names are based on publicly listed Philippine grocery products. The prices, costs, batches, supplier, sales, stock levels, and seasonal windows are synthetic. The `PH-` codes are internal demo SKUs for manual entry in the POS Barcode / SKU field. Read a package barcode directly when registering real stock.

For the product portfolio, see [Monde Nissin](https://mondenissin.com/our-brands/), [Century Pacific Food](https://www.centurypacific.com.ph/brands/), [Nestlé Philippines](https://www.nestle.com.ph/brands), [URC](https://www.urc.com.ph/stories/corporate-news/well-loved-urc-brands-are-now-available-on-lazada), [NutriAsia](https://nutriasia.com/export-operations/), and [Del Monte Philippines](https://www.delmontephil.com/our-products/products).

- **POS** — type `PH-MILO`, press Enter, and complete a test sale.
- **Low stock and expiry** — search for `PH-555-SARD` (stockout), `PH-CHUCKIE` (near expiry), and `PH-DM-CHUNKS` (expired batch).
- **Seasonality** — `PH-CREAM` is in season and `PH-DM-FIESTA` is off-season under the trial store's sample calendar.
- **Profit reports** — both 28-day periods contain receipts. The store's sample discount on `PH-CREAMO` can push its gross profit below zero.
- **Purchase orders** — review the Lucky Me! Pancit Canton draft, or generate a new set if there are eligible SKUs without drafts for today.

The catalog generator uses a fixed pseudo-random seed and 84 calendar days relative to the seeding date, with FEFO checkout, example promotions, variable restocks, intermittent sales, and censoring when demand exceeds available stock. The script adds data in the separate trial stores and skips them when the branded products are already present.

## Limits and integration

- Production needs an authorized store export and reliable stockout flags. Recorded sales and true demand can diverge. The ABC value proxy uses today's selling price and is distinct from realized revenue.
- The policy simulation uses an adaptive observation-based forecast. The existing Chronos evaluation is separate. Longitudinal production drift, a daily forecast refresh job, and actual supplier delivery lead-time data require further integration.
- The preview uses local structured tools by default. Launching with `--groq-tool-routing` and a configured `GROQ_API_KEY` enables the **Ask via Groq for this question** checkbox. The checked request sends trial question text to Groq for tool selection. SQL execution and answer values stay in the application. Use synthetic questions when enabled.
- Document RAG needs approved SOPs or supplier documents. Email, Telegram, and SMS need a chosen destination and delivery configuration. Keep a local demo recording and CSV for backup during the defense.

## Run

Follow the [local setup instructions](SETUP.md) to start on port 8005, add optional sample data, or run the verification scripts.
