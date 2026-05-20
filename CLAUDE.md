# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Flask app ([app.py](app.py)) + Jinja templates for a small home bakery in Jaipur ("Shrutiscakes and more"). Customers browse products, place orders, and confirm on WhatsApp. The baker reviews orders in a password-protected admin panel.

There is no test suite, no linter, no build step. The app is plain Flask 3 + vanilla JS in templates — no frontend framework, no bundler.

## Common commands

```powershell
# Run locally (debug + auto-reload)
pip install -r requirements.txt
python app.py                          # serves http://localhost:5000

# Quick syntax/import smoke test (used after edits to app.py)
python -c "import app; print('OK')"

# Docker (compose uses .env, mounts source as volumes — code changes apply live)
docker compose up
docker build -t my-bakery . ; docker run -p 5000:5000 my-bakery
```

Environment variables (defaults in [.env](.env)): `BAKERY_NAME`, `BAKER_WHATSAPP`, `BAKER_EMAIL`, `ADMIN_USER`, `ADMIN_PASSWORD`, `DATABASE_URL`. `DATABASE_URL` is unset locally → app uses SQLite at `data/bakery.db`. In production, set it to a Postgres URL (Neon/Supabase/Render Postgres). The app normalizes `postgres://` and `postgresql://` prefixes to `postgresql+psycopg://` so psycopg3 is used (psycopg2 has no Python 3.14 wheel).

## Architecture

### Routes & template flow

- `/` — `index.html`: hero, category honeycomb tiles, "Why us", featured cakes, testimonials, how-it-works, CTA banner.
- `/menu` — `menu.html`: shopping view, full cards with prices/order buttons, category filter pills.
- `/gallery` — `gallery.html`: image-only showcase, inline image-only lightbox (separate from the menu's modal).
- `/order` (GET/POST) — `order.html`: 2-step wizard (build items → contact). Multi-item cart.
- `/admin` (Basic Auth) — `admin.html`: table of orders with status filter, sort dropdown, delivered toggle.
- `/admin/<id>/toggle` (Basic Auth, POST) — flips delivered status, preserves filter/sort in redirect.
- `/orders` → redirects to `/admin` (legacy URL).

[templates/base.html](templates/base.html) provides shared header, hamburger nav (`<720px`), footer "Good to know" box, and the **floating WhatsApp FAB**. The FAB is inside `{% block whatsapp_fab %}` so [templates/admin.html](templates/admin.html) overrides it to empty.

[templates/_cake_modal.html](templates/_cake_modal.html) is the shared product lightbox used by `index.html` + `menu.html`. Its JS hooks `.cake-card .cake-image-wrap.clickable` — preserve that class hierarchy when adding new card variants.

### Product catalog

Products live in **[data/products.json](data/products.json)** — a plain JSON list. `load_products()` in [app.py](app.py) reads it with **mtime-based caching** (so edits are picked up on the next request without a Flask restart) and a **graceful fallback** to the last good version if the file becomes invalid JSON (a typo never takes the site down — failure is logged to stdout). Each entry has `id, category, name, price, image, description`. To add an item: edit the JSON file, drop the matching image into `static/images/`, refresh. Related Python constants still in [app.py](app.py):

- `CATEGORIES` — display order on home tiles + menu/gallery filter pills + order-wizard `<optgroup>` dropdown.
- `CATEGORY_ICONS` — emoji per category, used by the home honeycomb tiles.
- `SIZES_BY_CATEGORY` — category-specific size options (kg for Cakes/Cheesecakes, "Box of N" for Cupcakes/Cookies/Brownies, etc.). Empty list ⇒ size field hidden entirely. Serialized to JSON and dropped into [templates/order.html](templates/order.html) so the wizard rebuilds the dropdown live when the customer picks a different item.
- `SIZE_REQUIRED_CATEGORIES = {"Cakes", "Cheesecakes"}` — server only enforces size for these two. JS uses the same set to toggle the required asterisk.

### Order data model (V1 vs V2)

Orders evolved from a flat single-item shape to a multi-item cart:

```jsonc
// V2 (current)
{ "id": "...", "name": "...", "phone_code": "+91", "phone": "9876543210",
  "items": [
    { "cake": "Red Velvet Dream", "size": "1 kg", "flavor": "Red Velvet",
      "quantity": 1, "customization": "...", "image_filename": "20260513_0.jpg" }
  ],
  "needed_by": "...", "delivered": false }

// V1 (legacy)
{ "id": "...", "cake": "...", "size": "...", "flavor": "...", "customization": "...", ... }
```

`_legacy_items(order)` in [app.py](app.py) wraps V1 orders into a single-item list at read time so [templates/admin.html](templates/admin.html), [templates/thank_you.html](templates/thank_you.html), and the WhatsApp message all iterate `items` uniformly. **Do not migrate the file** — just rely on the on-read shim.

### Cart submission — JSON-in-hidden-input, not repeating form fields

The wizard cart is JS state: an `items` array kept in [templates/order.html](templates/order.html). On submit, the array is JSON-stringified into a single hidden `items_json` input. The server's `_parse_items_json(raw, order_id)` parses, validates (cake + flavor required; size required only for `SIZE_REQUIRED_CATEGORIES`), and clamps quantity to 1–50.

The form is `novalidate` because hidden `display:none` required fields silently break Chrome's HTML5 submit validation — all validation happens in JS (per-step `validateCurrent`) and on the server.

### Reference image uploads

Customers can attach a per-item image. The client reads the file with `FileReader.readAsDataURL`, embeds the base64 data URL inside the item's `image_data` field in `items_json`. `_parse_items_json` extracts it and `_save_image_data_url()` decodes + writes to `static/uploads/<order_id>_<idx>.<ext>`. Validation: extension ∈ `{jpg, jpeg, png, webp, gif}`, raw bytes ≤ 5 MB. The saved filename is stored on the item as `image_filename`; raw base64 is dropped before writing the order, so `orders.json` doesn't bloat.

`app.config["MAX_CONTENT_LENGTH"] = 32 MB` accommodates several large items per request.

### Persistence — orders live in a real database

Orders are stored in an SQL database via **Flask-SQLAlchemy** (model: `Order` in [app.py](app.py)). The connection is configured from `DATABASE_URL`:

- **Local dev** — unset → uses **SQLite** at [data/bakery.db](data/bakery.db). File-backed, no setup.
- **Production** — set to a Postgres URL from Neon/Supabase/Render Postgres. The URL is auto-normalized to `postgresql+psycopg://` so psycopg3 is used (the only Postgres driver with a Python 3.14 wheel).

Schema is created automatically at startup via `db.create_all()`. The `Order` model has one row per order; the `items` field is a `JSON` column (JSONB on Postgres, JSON-as-TEXT on SQLite) holding the cart list.

**One-time migration**: on first boot, `_migrate_json_to_db()` checks for an existing `orders.json`. If the DB is empty and the file has data, it imports everything (calling `_legacy_items()` to wrap pre-V2 flat orders into the multi-item shape). `orders.json` is left in place as a backup but is no longer read or written after that.

### Auth

`@requires_auth` decorator on [app.py](app.py) gates `/admin` and the toggle endpoint with HTTP Basic Auth. Defaults are `admin`/`bakery123`. A warning is logged on every startup while defaults are in use. Browsers cache Basic Auth credentials for the session, which makes the auth *look* absent on revisits — when debugging "auth not working", test in incognito.

`@app.context_processor inject_globals` exposes `baker_whatsapp` and `bakery_name` to every template — used by the WhatsApp FAB in `base.html`.

## Gotchas

- **Jinja `{{ o.items }}` returns the dict's `.items` METHOD, not the `"items"` key.** Always use `{{ o['items'] }}` for fields whose names collide with dict methods (`items`, `keys`, `values`, `get`). This bit us once; see [templates/admin.html](templates/admin.html) and [templates/thank_you.html](templates/thank_you.html).
- **Flask's auto-reloader sometimes misses changes on Windows.** When templates or app.py edits don't appear, fully restart `python app.py` (Ctrl+C, re-run). Browser-side: hard-refresh (Ctrl+Shift+R) — the customer-facing pages have inline `<script>` blocks the browser may cache.
- **Product image filenames are referenced by exact name from `CAKES`.** If a referenced file isn't in `static/images/`, the card shows a soft-beige placeholder (the `--soft` color on `.cake-image`'s `background-color`). Several products currently reference filenames the user hasn't dropped in yet (`cookie2.jpeg`, `cupcake3.jpeg`, etc.) — this is intentional.
- **The 7-category honeycomb tile layout on home** uses an 8-column CSS grid with explicit `nth-child` column positions for the offset bottom row. Adding/removing a category requires updating both `CATEGORIES` *and* the `.menu-tile:nth-child(N)` rules in [static/css/style.css](static/css/style.css), or breaking the layout. Below 720px it falls back to a 2-column grid.
- **`datetime.utcnow()`** is deprecated in Python 3.12+ but used throughout for order IDs/timestamps. IDE will flag it as a hint — leave it; migrating to timezone-aware datetimes would change the on-disk format.
