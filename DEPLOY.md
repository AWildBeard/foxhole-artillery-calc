# Deploying the Artillery Broker Worker

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- Node.js 18+ installed

## Steps

### 1. Install Wrangler

```bash
cd worker
npm install
```

### 2. Authenticate with Cloudflare

```bash
npx wrangler login
```

This opens a browser window. Log in with your Cloudflare account and authorize Wrangler.

### 3. Deploy the worker

```bash
npm run deploy
```

Wrangler will:
- Create the Worker
- Create the Durable Objects namespace (`ArtilleryRoom`)
- Apply the migration that registers the class

On first deploy you will see output like:

```
Uploaded artillery-broker (1.23 sec)
Published artillery-broker (0.45 sec)
  https://artillery-broker.<your-subdomain>.workers.dev
```

Copy that URL.

### 4. Configure the client

Open `js/broker.js` and replace the placeholder with your deployed URL:

```js
// Before:
var WORKER_URL = "wss://artillery-broker.YOUR_SUBDOMAIN.workers.dev";

// After (use wss:// — Cloudflare Workers always serve over TLS):
var WORKER_URL = "wss://artillery-broker.<your-subdomain>.workers.dev";
```

### 5. Test

Open `index.html` in two browser tabs. In the first tab:
1. Click **Artillery Broker**
2. Enter any OP Code (e.g. `test-1`)
3. Select **Artillery**, enter a 10-digit grid and altitude, click **Go Online**

In the second tab:
1. Click **Artillery Broker**
2. Enter the same OP Code (`test-1`)
3. Select **Spotter** — the battery from the first tab should appear
4. Enter a target grid and select the battery — a fire mission result appears
5. Click **Send Fire Mission** — the artillery tab receives the mission

## Local development

To run the worker locally (requires a paid Cloudflare plan for Durable Objects, or use `--remote`):

```bash
cd worker
npm run dev -- --remote
```

`--remote` routes traffic through your actual Cloudflare account, which supports Durable Objects without a paid plan.

## Notes

- **OP Codes** are case-sensitive and may contain letters, numbers, hyphens, and underscores (1–32 characters). Share an OP Code only with players in your session.
- The worker stores no data persistently. All session state lives in memory inside the Durable Object. Restarting the worker or the Durable Object evicts all sessions.
- CORS is open (`*`) so the page can be served from any host (GitHub Pages, a local file, etc.).
- Cloudflare's free tier includes 100,000 Durable Object requests per day, which is more than sufficient for small-group use.
- The migration uses `new_sqlite_classes` (required for Durable Objects on the free plan).