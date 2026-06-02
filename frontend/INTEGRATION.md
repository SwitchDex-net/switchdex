# Connecting the frontend to the backend

The React app (`switchdex.jsx`) talks to this backend through a single API
client. There are two ways it runs:

## The switch: `MOCK_MODE`

At the top of `switchdex.jsx`:

```js
const MOCK_MODE = true;   // standalone demo with simulated data
// const MOCK_MODE = false;  // talk to the real backend
```

- **`true`** — the app runs entirely in the browser with simulated devices,
  configs, and a fake SSH shell. No backend needed. Useful for UI work and demos.
- **`false`** — every data operation goes through the `api` client to this
  backend: login, inventory, config archive, and the WebSocket SSH terminal.

Flip it to `false` for production. That's the only code change required.

## What gets wired when `MOCK_MODE = false`

| UI action | Calls |
|---|---|
| Login screen | `POST /api/auth/login` → stores JWT, attaches `Authorization: Bearer` to all calls |
| Inventory load | `GET /api/devices` on mount |
| Add device (after probe) | `POST /api/devices` |
| Back up now / fleet backup | `POST /api/devices/{id}/backup`, `POST /api/backup-all` |
| Restore a version | `POST /api/devices/{id}/restore/{vid}` |
| SSH terminal | `WS /ws/ssh/{id}?token=…` (raw shell stream) |
| Token expiry | a `401` from any call fires an `of-unauthorized` event → app returns to login |

The token is kept in `localStorage` (key `of_token`), guarded with try/catch so
it never throws in restricted environments.

## API base URL

Defaults to **same-origin `/api`** — correct when the app is served by the same
Caddy front door that proxies the backend (the appliance default). To point a
separately-hosted frontend at the backend, set before the app loads:

```html
<script>window.SWITCHDEX_API = "https://nms.example.com"</script>
```

## Building the frontend into the appliance

The Caddyfile serves static files from `/srv/www`. Build the React app and place
the output there (the appliance image bakes this in during `provision.sh`):

```bash
npm run build           # vite/CRA → dist/ or build/
# copy the output to the image's /srv/www (mounted into the caddy container)
```

`frontend/api.js` in this repo is the standalone version of the same client —
import it (`import api from "./api"`) in a multi-file project instead of the copy
embedded at the top of `switchdex.jsx`.

## First login

On first backend start a bootstrap admin is created with a random password
printed to the logs:

```bash
docker compose logs backend | grep -A4 "bootstrap admin"
```

Log in as `admin` with that password; you'll be prompted to change it. Then add
local users and/or configure LDAP under **Settings**.
