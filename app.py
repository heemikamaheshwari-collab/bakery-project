import base64
import json
import os
import re
from datetime import datetime
from functools import wraps
from urllib.parse import quote
from dotenv import load_dotenv
from flask import Flask, render_template, request, redirect, url_for, Response
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import String, DateTime, Boolean, JSON

load_dotenv(override=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024


# Database URL: use DATABASE_URL env var if set (Postgres/Neon/Supabase in production);
# otherwise default to a local SQLite file for development.
_db_url = os.environ.get("DATABASE_URL", "").strip()
if _db_url:
    # Normalize legacy Heroku-style prefix and force the psycopg3 driver
    # (the wheel that's actually installable on Python 3.14).
    if _db_url.startswith("postgres://"):
        _db_url = "postgresql+psycopg://" + _db_url[len("postgres://"):]
    elif _db_url.startswith("postgresql://"):
        _db_url = "postgresql+psycopg://" + _db_url[len("postgresql://"):]
    app.config["SQLALCHEMY_DATABASE_URI"] = _db_url
    print(f"[db] Using Postgres database")
else:
    _data_dir = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(_data_dir, exist_ok=True)
    app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{os.path.join(_data_dir, 'bakery.db')}"
    print(f"[db] Using local SQLite at data/bakery.db (set DATABASE_URL for Postgres)")

db = SQLAlchemy(app)


class Order(db.Model):
    __tablename__ = "orders"
    id = db.Column(String(20), primary_key=True)
    created_at = db.Column(DateTime, nullable=False, default=datetime.utcnow)
    name = db.Column(String(120), nullable=False)
    phone_code = db.Column(String(8), default="+91")
    phone = db.Column(String(20), default="")
    email = db.Column(String(200), default="")
    needed_by = db.Column(String(20), default="")
    delivery_address = db.Column(db.Text, default="")
    receiver_phone = db.Column(String(20), default="")
    items = db.Column(JSON, nullable=False, default=list)
    delivered = db.Column(Boolean, nullable=False, default=False)

    def to_dict(self):
        return {
            "id": self.id,
            "created_at": self.created_at.isoformat() if self.created_at else "",
            "name": self.name,
            "phone_code": self.phone_code or "",
            "phone": self.phone or "",
            "email": self.email or "",
            "needed_by": self.needed_by or "",
            "delivery_address": self.delivery_address or "",
            "receiver_phone": self.receiver_phone or "",
            "items": self.items or [],
            "delivered": bool(self.delivered),
        }


def _ensure_schema():
    """Add new columns to existing orders table if missing (poor-man's migration).

    Lets us add Order fields after the DB was first created without dropping data.
    Works for both SQLite (local) and Postgres (production).
    """
    from sqlalchemy import inspect, text
    inspector = inspect(db.engine)
    if "orders" not in inspector.get_table_names():
        return
    existing = {c["name"] for c in inspector.get_columns("orders")}
    new_cols = {
        "delivery_address": "TEXT DEFAULT ''",
        "receiver_phone": "VARCHAR(20) DEFAULT ''",
    }
    with db.engine.begin() as conn:
        for col, ddl in new_cols.items():
            if col not in existing:
                conn.execute(text(f"ALTER TABLE orders ADD COLUMN {col} {ddl}"))
                print(f"[db] Added column orders.{col}")


def _legacy_items(order):
    """Build a single-item list from old flat-field orders so display code is uniform."""
    if not order.get("cake"):
        return []
    return [{
        "cake": order.get("cake", ""),
        "size": order.get("size") or order.get("servings") or "",
        "flavor": order.get("flavor", ""),
        "quantity": 1,
        "customization": order.get("customization", ""),
    }]


def _migrate_json_to_db():
    """One-time import: if the DB has no orders but orders.json exists, copy it in."""
    if Order.query.first() is not None:
        return
    legacy_file = os.path.join(os.path.dirname(__file__), "orders.json")
    if not os.path.exists(legacy_file):
        return
    try:
        with open(legacy_file, "r", encoding="utf-8") as f:
            raw_orders = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[db] Skipping orders.json migration: {e}")
        return
    if not raw_orders:
        return
    print(f"[db] Migrating {len(raw_orders)} order(s) from orders.json into database...")
    for o in raw_orders:
        items = o.get("items") or _legacy_items(o)
        created_raw = o.get("created_at")
        try:
            created_dt = datetime.fromisoformat(created_raw) if created_raw else datetime.utcnow()
        except (ValueError, TypeError):
            created_dt = datetime.utcnow()
        db.session.add(Order(
            id=o.get("id") or created_dt.strftime("%Y%m%d%H%M%S"),
            created_at=created_dt,
            name=o.get("name", ""),
            phone_code=o.get("phone_code", "+91"),
            phone=o.get("phone", ""),
            email=o.get("email", ""),
            needed_by=o.get("needed_by", ""),
            items=items,
            delivered=bool(o.get("delivered", False)),
        ))
    db.session.commit()
    print(f"[db] Migration complete. orders.json kept as a backup.")


with app.app_context():
    db.create_all()
    _ensure_schema()
    _migrate_json_to_db()


UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "static", "uploads")
try:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
except OSError:
    # Read-only filesystem (e.g. Vercel serverless). We use Vercel Blob instead.
    pass

_ALLOWED_IMAGE_EXTS = {"jpeg", "jpg", "png", "webp", "gif"}
_DATA_URL_RE = re.compile(r"^data:image/(\w+);base64,(.+)$", re.DOTALL)
_BLOB_TOKEN = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()


def _upload_to_vercel_blob(raw_bytes, pathname, content_type):
    """PUT raw bytes to Vercel Blob storage, return the public URL.

    Uses the Blob REST API directly (no SDK dependency). Requires the
    BLOB_READ_WRITE_TOKEN env var set in the Vercel project.
    """
    import urllib.request
    req = urllib.request.Request(
        f"https://blob.vercel-storage.com/{pathname}",
        data=raw_bytes,
        method="PUT",
        headers={
            "Authorization": f"Bearer {_BLOB_TOKEN}",
            "x-content-type": content_type,
            "x-api-version": "7",
            "x-add-random-suffix": "0",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    return result.get("url", "")


def _save_image_data_url(data_url, order_id, idx):
    """Decode a base64 image data URL and store it.

    Returns either a URL (Vercel Blob, in production) or a filename
    (local disk, in development). The `image_url` Jinja filter resolves
    either form to a renderable src.
    """
    if not data_url:
        return ""
    m = _DATA_URL_RE.match(data_url)
    if not m:
        return ""
    ext = m.group(1).lower()
    if ext == "jpeg":
        ext = "jpg"
    if ext not in _ALLOWED_IMAGE_EXTS:
        return ""
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except (ValueError, TypeError):
        return ""
    if len(raw) > 5 * 1024 * 1024:
        return ""

    pathname = f"orders/{order_id}_{idx}.{ext}"

    if _BLOB_TOKEN:
        try:
            return _upload_to_vercel_blob(raw, pathname, f"image/{ext if ext != 'jpg' else 'jpeg'}")
        except Exception as e:
            print(f"[upload] Vercel Blob upload failed for {pathname}: {e}")
            return ""

    filename = f"{order_id}_{idx}.{ext}"
    try:
        with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
            f.write(raw)
    except OSError as e:
        print(f"[upload] Local save failed for {filename}: {e}")
        return ""
    return filename

BAKERY_NAME = os.environ.get("BAKERY_NAME", "Shrutiscakes and more")
BAKER_WHATSAPP = os.environ.get("BAKER_WHATSAPP", "919026604262")
BAKER_EMAIL = os.environ.get("BAKER_EMAIL", "baker@example.com")

ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "bakery123")
if ADMIN_PASSWORD == "bakery123":
    print("[admin] WARNING: using default password 'bakery123'. "
          "Set ADMIN_PASSWORD env var to change it.")


def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or auth.username != ADMIN_USER or auth.password != ADMIN_PASSWORD:
            return Response(
                "Authentication required.", 401,
                {"WWW-Authenticate": 'Basic realm="Bakery Admin"'},
            )
        return f(*args, **kwargs)
    return decorated


@app.context_processor
def inject_globals():
    return {"baker_whatsapp": BAKER_WHATSAPP, "bakery_name": BAKERY_NAME}


@app.template_filter("image_url")
def _image_url(value):
    """Resolve a stored image reference to a renderable src.

    - Empty / None → empty string
    - Already an http(s) URL (Vercel Blob) → returned as-is
    - Plain filename (local disk fallback) → prefixed with /static/uploads/
    """
    if not value:
        return ""
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return url_for("static", filename=f"uploads/{value}")


CATEGORIES = ["Cakes", "Cupcakes", "Cookies", "Brownies", "Cheesecakes", "Jar Cakes", "Gift Hampers"]
CATEGORY_ICONS = {
    "Cakes": "🎂",
    "Cupcakes": "🧁",
    "Cookies": "🍪",
    "Brownies": "🍫",
    "Cheesecakes": "🍰",
    "Jar Cakes": "🍯",
    "Gift Hampers": "🎁",
}

PRODUCTS_FILE = os.path.join(os.path.dirname(__file__), "data", "products.json")
_products_cache = {"data": None, "mtime": 0}


def load_products():
    """Read products from data/products.json.

    Uses mtime-based caching so editing the file is picked up on the next request
    without restarting Flask. If the file is missing or has invalid JSON, falls
    back to the last good cached version (so a typo never takes the site down).
    """
    try:
        mtime = os.path.getmtime(PRODUCTS_FILE)
    except OSError:
        return _products_cache["data"] or []

    if _products_cache["data"] is not None and _products_cache["mtime"] == mtime:
        return _products_cache["data"]

    try:
        with open(PRODUCTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            raise ValueError("products.json root must be a list")
    except (json.JSONDecodeError, ValueError, OSError) as e:
        print(f"[products] FAILED to parse {PRODUCTS_FILE}: {e}")
        if _products_cache["data"] is not None:
            print(f"[products] Falling back to last good version "
                  f"({len(_products_cache['data'])} items)")
            return _products_cache["data"]
        return []

    _products_cache["data"] = data
    _products_cache["mtime"] = mtime
    return data

SIZES = [
    {"value": "0.5 kg", "label": "0.5 kg — serves 4–6"},
    {"value": "1 kg",   "label": "1 kg — serves 8–10"},
    {"value": "1.5 kg", "label": "1.5 kg — serves 12–15"},
    {"value": "2 kg",   "label": "2 kg — serves 16–20"},
    {"value": "3 kg",   "label": "3 kg — serves 25–30"},
]

SIZES_BY_CATEGORY = {
    "Cakes": SIZES,
    "Cheesecakes": [
        {"value": "0.5 kg", "label": "0.5 kg — serves 4–6"},
        {"value": "1 kg",   "label": "1 kg — serves 8–10"},
        {"value": "1.5 kg", "label": "1.5 kg — serves 12–15"},
    ],
    "Cupcakes": [
        {"value": "Box of 6",  "label": "Box of 6 cupcakes"},
        {"value": "Box of 12", "label": "Box of 12 cupcakes"},
    ],
    "Brownies": [
        {"value": "Box of 6",  "label": "Box of 6 brownies"},
        {"value": "Box of 9",  "label": "Box of 9 brownies"},
        {"value": "Box of 12", "label": "Box of 12 brownies"},
    ],
    "Cookies": [
        {"value": "Box of 6",  "label": "Box of 6 cookies"},
        {"value": "Box of 12", "label": "Box of 12 cookies"},
    ],
    "Jar Cakes": [
        {"value": "1 jar",     "label": "Single jar"},
        {"value": "Set of 4",  "label": "Set of 4 jars"},
        {"value": "Set of 6",  "label": "Set of 6 jars"},
    ],
    "Gift Hampers": [],
    "Other": [],
}

FLAVORS = [
    "Chocolate", "Vanilla", "Red Velvet", "Black Forest",
    "Pineapple", "Butterscotch", "Strawberry", "Coffee", "Coconut",
]

COUNTRY_CODES = [
    {"code": "+91",  "name": "India"},
    {"code": "+1",   "name": "USA / Canada"},
    {"code": "+44",  "name": "UK"},
    {"code": "+971", "name": "UAE"},
    {"code": "+61",  "name": "Australia"},
    {"code": "+65",  "name": "Singapore"},
    {"code": "+966", "name": "Saudi Arabia"},
    {"code": "+974", "name": "Qatar"},
    {"code": "+49",  "name": "Germany"},
    {"code": "+33",  "name": "France"},
]


def load_orders():
    """Return all orders as dicts (newest data shape; matches former JSON layout)."""
    return [o.to_dict() for o in Order.query.all()]


def save_order(order):
    """Insert a single order dict into the database."""
    created = order.get("created_at")
    if isinstance(created, str) and created:
        try:
            created_dt = datetime.fromisoformat(created)
        except ValueError:
            created_dt = datetime.utcnow()
    else:
        created_dt = datetime.utcnow()
    row = Order(
        id=order.get("id") or datetime.utcnow().strftime("%Y%m%d%H%M%S"),
        created_at=created_dt,
        name=order.get("name", ""),
        phone_code=order.get("phone_code", "+91"),
        phone=order.get("phone", ""),
        email=order.get("email", ""),
        needed_by=order.get("needed_by", ""),
        delivery_address=order.get("delivery_address", ""),
        receiver_phone=order.get("receiver_phone", ""),
        items=order.get("items", []),
        delivered=bool(order.get("delivered", False)),
    )
    db.session.add(row)
    db.session.commit()
    print(f"[orders] saved order {row.id} ({len(row.items or [])} items)")


def build_whatsapp_link(order):
    full_phone = f"{order.get('phone_code', '')} {order.get('phone', '')}".strip()
    lines = [
        f"Hello {BAKERY_NAME}! I would like to place an order:",
        f"Name: {order['name']}",
        f"Phone: {full_phone}",
    ]
    if order.get("receiver_phone"):
        lines.append(f"Receiver's phone: {order['receiver_phone']}")
    lines += ["", "Items:"]
    items = order.get("items") or _legacy_items(order)
    for i, it in enumerate(items, 1):
        qty = it.get("quantity", 1)
        lines.append(f"  {i}. {it['cake']} — {it['size']}, {it['flavor']} × {qty}")
        if it.get("customization"):
            lines.append(f"     Note: {it['customization']}")
    lines.append("")
    if order.get("delivery_address"):
        lines.append(f"Delivery address: {order['delivery_address']}")
    lines.append(f"Needed by: {order.get('needed_by') or 'Not specified'}")
    lines.append("")
    lines.append("(Delivery charges will be confirmed on chat based on location.)")
    message = "\n".join(lines)
    return f"https://wa.me/{BAKER_WHATSAPP}?text={quote(message)}"


def _group_by_category(items):
    grouped = {}
    for it in items:
        grouped.setdefault(it.get("category", "Other"), []).append(it)
    return [(cat, grouped[cat]) for cat in CATEGORIES if cat in grouped]


@app.route("/")
def home():
    products = load_products()
    featured = products[:3]
    category_counts = {c: sum(1 for it in products if it.get("category") == c) for c in CATEGORIES}
    category_images = {}
    for cat in CATEGORIES:
        first = next((it for it in products if it.get("category") == cat), None)
        category_images[cat] = first["image"] if first else ""
    return render_template(
        "index.html",
        bakery_name=BAKERY_NAME,
        featured=featured,
        categories=CATEGORIES,
        category_icons=CATEGORY_ICONS,
        category_counts=category_counts,
        category_images=category_images,
    )


def _filtered_products():
    selected = request.args.get("category", "all")
    products = load_products()
    if selected != "all" and selected in CATEGORIES:
        items = [c for c in products if c.get("category") == selected]
    else:
        items = products
        selected = "all"
    return items, selected


@app.route("/menu")
def menu():
    items, selected = _filtered_products()
    return render_template(
        "menu.html",
        bakery_name=BAKERY_NAME,
        cakes=items,
        categories=CATEGORIES,
        selected=selected,
    )


@app.route("/gallery")
def gallery():
    items, selected = _filtered_products()
    return render_template(
        "gallery.html",
        bakery_name=BAKERY_NAME,
        cakes=items,
        categories=CATEGORIES,
        selected=selected,
    )


@app.route("/admin")
@requires_auth
def admin_view():
    status = request.args.get("status", "all")
    sort = request.args.get("sort", "newest")
    if status not in ("all", "pending", "delivered"):
        status = "all"
    if sort not in ("newest", "oldest"):
        sort = "newest"

    orders = load_orders()
    for o in orders:
        created = o.get("created_at", "")
        o["created_display"] = created[:16].replace("T", " ") if created else ""
        o.setdefault("delivered", False)
        if not o.get("items"):
            o["items"] = _legacy_items(o)
        o["item_count"] = sum(it.get("quantity", 1) for it in o["items"]) or 0

    total = len(orders)
    pending_count = sum(1 for o in orders if not o["delivered"])
    delivered_count = total - pending_count

    if status == "pending":
        orders = [o for o in orders if not o["delivered"]]
    elif status == "delivered":
        orders = [o for o in orders if o["delivered"]]

    orders.sort(key=lambda o: o.get("created_at", ""), reverse=(sort == "newest"))

    counts = {"all": total, "pending": pending_count, "delivered": delivered_count}
    return render_template(
        "admin.html",
        bakery_name=BAKERY_NAME,
        orders=orders,
        status=status,
        sort=sort,
        counts=counts,
    )


@app.route("/orders")
def orders_redirect():
    return redirect(url_for("admin_view"))


@app.route("/admin/<order_id>/toggle", methods=["POST"])
@requires_auth
def toggle_delivered(order_id):
    row = db.session.get(Order, order_id)
    if row is not None:
        row.delivered = not bool(row.delivered)
        db.session.commit()
    return redirect(url_for(
        "admin_view",
        status=request.args.get("status", "all"),
        sort=request.args.get("sort", "newest"),
    ))


def _render_order_form(preselected, form, error=None):
    products = load_products()
    return render_template(
        "order.html",
        bakery_name=BAKERY_NAME,
        cakes=products,
        grouped_cakes=_group_by_category(products),
        sizes=SIZES,
        sizes_by_category_json=json.dumps(SIZES_BY_CATEGORY),
        flavors=FLAVORS,
        country_codes=COUNTRY_CODES,
        preselected=preselected,
        form=form,
        error=error,
    )


SIZE_REQUIRED_CATEGORIES = {"Cakes", "Cheesecakes"}


def _category_for(cake_name):
    for c in load_products():
        if c["name"] == cake_name:
            return c.get("category", "")
    return ""


def _parse_items_json(raw, order_id=None):
    try:
        data = json.loads(raw or "[]")
        if not isinstance(data, list):
            return []
    except (ValueError, TypeError):
        return []
    cleaned = []
    for idx, it in enumerate(data):
        if not isinstance(it, dict):
            continue
        cake = str(it.get("cake", "")).strip()
        size = str(it.get("size", "")).strip()
        flavor = str(it.get("flavor", "")).strip()
        if not cake or not flavor:
            continue
        if _category_for(cake) in SIZE_REQUIRED_CATEGORIES and not size:
            continue
        try:
            qty = int(it.get("quantity", 1))
        except (ValueError, TypeError):
            qty = 1
        qty = max(1, min(50, qty))
        image_filename = ""
        if order_id and it.get("image_data"):
            image_filename = _save_image_data_url(it.get("image_data"), order_id, idx)
        cleaned.append({
            "cake": cake,
            "size": size,
            "flavor": flavor,
            "quantity": qty,
            "customization": str(it.get("customization", "")).strip(),
            "image_filename": image_filename,
        })
    return cleaned


@app.route("/order", methods=["GET", "POST"])
def order():
    preselected = request.args.get("cake", "")
    if request.method == "POST":
        order_id = datetime.utcnow().strftime("%Y%m%d%H%M%S")
        items_raw = request.form.get("items_json", "[]")
        items = _parse_items_json(items_raw, order_id=order_id)
        phone_digits = "".join(c for c in request.form.get("phone", "") if c.isdigit())[:10]
        receiver_digits = "".join(c for c in request.form.get("receiver_phone", "") if c.isdigit())[:10]
        order_data = {
            "id": order_id,
            "created_at": datetime.utcnow().isoformat(),
            "name": request.form.get("name", "").strip(),
            "phone_code": request.form.get("phone_code", "+91").strip(),
            "phone": phone_digits,
            "email": request.form.get("email", "").strip(),
            "items": items,
            "needed_by": request.form.get("needed_by", "").strip(),
            "delivery_address": request.form.get("delivery_address", "").strip(),
            "receiver_phone": receiver_digits,
            "delivered": False,
        }
        if not items:
            return _render_order_form(preselected, {**order_data, "items_json": items_raw},
                "Please add at least one item with a size and flavor.")
        if not order_data["name"] or len(order_data["phone"]) != 10:
            return _render_order_form(preselected, {**order_data, "items_json": items_raw},
                "Please enter your name and a valid 10-digit phone number.")
        if not order_data["delivery_address"]:
            return _render_order_form(preselected, {**order_data, "items_json": items_raw},
                "Please enter a delivery address.")
        save_order(order_data)
        wa_link = build_whatsapp_link(order_data)
        return render_template(
            "thank_you.html",
            bakery_name=BAKERY_NAME,
            order=order_data,
            wa_link=wa_link,
            baker_email=BAKER_EMAIL,
        )
    return _render_order_form(preselected, {})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)

    


