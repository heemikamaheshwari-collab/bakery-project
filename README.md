# Home Bakery Website

A simple Flask website for a home bakery. Customers can browse cakes, see photos, and place orders with custom requests. Orders are saved locally and sent to the baker via a pre-filled WhatsApp link.

## Features
- Home page with featured cakes and "how it works"
- Gallery of all cakes with prices
- Order form with customization field (theme, message, allergies, etc.)
- On submit: order is saved to `orders.json` + a WhatsApp lvink is generated with the order details
- Responsive design (works on phones)
- Fully Dockerized

## Running locally (without Docker)

```powershell
cd C:\Users\91829\my-bakery
pip install -r requirements.txt
python app.py
```

Then open http://localhost:5000

## Running with Docker

```powershell
cd C:\Users\91829\my-bakery
docker build -t my-bakery .
docker run -p 5000:5000 my-bakery
```

Open http://localhost:5000

## Configuration

Set these as environment variables (or edit the defaults in `app.py`):

| Variable | What it is | Example |
|---|---|---|
| `BAKERY_NAME` | Your bakery's name | `"Hitu's Home Bakery"` |
| `BAKER_WHATSAPP` | Your WhatsApp number with country code, no `+` or spaces | `"919876543210"` |
| `BAKER_EMAIL` | Your email (shown on thank-you page) | `"hitu@example.com"` |

With Docker:
```powershell
docker run -p 5000:5000 `
  -e BAKERY_NAME="Hitu's Home Bakery" `
  -e BAKER_WHATSAPP="919876543210" `
  -e BAKER_EMAIL="hitu@example.com" `
  my-bakery
```

## Adding real cake photos

Drop your `.jpg` files into `static/images/` with these names (matching `app.py`):
- `cake1.jpg`, `cake2.jpg`, `cake3.jpg`, `cake4.jpg`, `cake5.jpg`, `cake6.jpg`

To change cake names/prices/descriptions, edit the `CAKES` list at the top of `app.py`.

## Viewing orders

Orders are saved to `orders.json` in the project folder. Open it in any text editor.

## Next steps (portfolio improvements)
- Add an admin login page to view orders in the browser
- Switch from `orders.json` to SQLite or PostgreSQL
- Add an AI feature: "Describe your dream cake" → AI suggests design + ingredients (uses Claude API)
- Deploy to Render, Fly.io, or Railway (free tiers, all support Docker)
