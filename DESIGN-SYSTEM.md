# SmartStock AI · Design system

## Foundations

| Token | Light theme | Purpose |
| --- | --- | --- |
| Brand green | #16A34A | Status accents, identity, progress |
| Action green | #15803D | Filled controls with white text |
| POS orange | #F97316 | Checkout entry and completion, with deep-brown text |
| AI violet | #6366F1 | Forecast and AI identity, with darker violet for light-theme text |
| Danger | #EF4444 | Expired stock, stockouts, destructive actions |
| Warning | #F59E0B | Near expiry, low stock, attention |
| Canvas / ink | #F8FAFC / #0F172A | Light background and reading text |
| Dark canvas / surface | #0B1220 / #121E30 | Dark mode shell and cards |

Inter variable is self-hosted. Segoe UI and system sans-serif are fallbacks. Titles and primary numbers are bold, with tabular digits for pesos and quantities. Supporting labels use muted text of at least 11px. The spacing scale uses 4, 8, 12, 16, and 24px. Standard card radius is 16px, and primary interactive controls have a 44px minimum target.

## Layout and components

At 390px, Home, Items, POS, Ask AI, and More are reachable from a bottom dock. More opens a native dialog with the remaining routes. At widths above 760px, the same workspace uses a sidebar. Focus outlines are visible, statuses pair an icon with text, and the browser's offline signal warns before saving.

| Screen | UI and data |
| --- | --- |
| Home / Daily Digest | Store greeting, owner's sale and profit cards, inventory flags, prioritized action cards, seven-day units chart, and synthetic money impact |
| Point of Sale | Searchable product grid, barcode controls, mobile cart sheet, and existing receipt flow |
| Items | Responsive catalog, stock and expiry filter chips, product maintenance, and stock/sales/forecast overview |
| Suggested Orders | Supplier groups, pending queue, approval confirmation, edit/reject note, and evidence sheet |
| Forecast | Daily P50 and P10–P90 band when the API supplies those values. The 30-day view indicates actual coverage |
| AI Assistant | Tap-to-fill prompts, grounded answers, source chips, and measured latency |
| Alerts | Filters for reorder, stockouts, expiry, and existing excess-stock decisions |
| Evaluation | Existing holdout metrics and actual/predicted units, plus the Daily Digest policy simulator |

The UI work consumes the existing endpoints. Store accounting, POS tender handling, forecasts, approval rules, and the database are outside this presentation change. Receipt completion uses the existing discount and checkout inputs. Per-draft approval is available. Cash/GCash settlement, bulk approval, server-streamed assistant text, and a holiday event feed would need separate implementation. Forecast details mark payday calendar dates and show current API coverage.

Inter is distributed under the SIL Open Font License. See `static/fonts/Inter-LICENSE.txt`.
