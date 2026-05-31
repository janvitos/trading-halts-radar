# Trading Halts Radar

Local Node.js web dashboard for live U.S. exchange trade halt monitoring using the NASDAQ Trader Trade Halt RSS feed.

This project is intended as an informational monitoring dashboard. It is not financial advice, trading advice, or a substitute for official exchange notices.

## Features

- Lists current trade halts from `https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts`.
- Highlights volatility/LULD-related halt codes: `LUDP`, `LUDS`, `M`, `T5`, and `T7`.
- Predicts volatility halt resume windows using configurable `5m`, `10m`, and `20m` windows.
- Uses official `ResumptionTradeTime` when available, overriding predictions.
- Browser notifications for halt detection and resumption countdowns.
- Global toggle for all volatility halt alerts.
- Per-symbol alert toggles when global volatility alerts are off.
- User preferences, filters, and per-symbol alerts are stored per browser in `localStorage`, not centrally on the server.
- Responsive dark UI for mobile, tablet, and desktop.

## Important Limitations

- Browser alerts require the dashboard tab to remain open.
- The free NASDAQ Trader RSS feed should not be queried more than once per minute.
- Predictions are only for volatility-style halts and are clearly labeled as predictions.
- Official `ResumptionTradeTime` is the source of truth when available.
- Non-volatility halts, such as news pending or regulatory halts, do not use fixed resume predictions.

## Setup

Requirements:

- Node.js 20 or newer
- npm

Recommended local launch:

On Linux/macOS:

```bash
./start.sh
```

On Windows:

```bat
start.bat
```

The launcher scripts install dependencies on first run, rebuild the dashboard, and start the production server. On later runs, dependency installation is skipped unless `package.json` or `package-lock.json` changed.

Open:

```text
http://localhost:8787
```

The port can be changed with the `THR_PORT` environment variable.

## Development

For Vite development mode:

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal, usually:

```text
http://localhost:5173
```

The backend runs on:

```text
http://localhost:8787
```

In development mode, opening the backend URL directly shows only the backend server. Use the Vite URL for the dashboard.

## Production Build

```bash
npm run build
npm start
```

Then open:

```text
http://localhost:8787
```

In production mode, the Express server serves the compiled Vite app from `dist/` and exposes the API and server-sent events from the same origin.

## Configuration

Environment variables:

- `THR_PORT`: backend port, default `8787`.
- `HALT_RSS_URL`: RSS feed URL, default NASDAQ Trader trade halt RSS.
- `POLL_INTERVAL_MS`: polling interval, default `60000`.

Copy `.env.example` if you want a local reference for configurable values. The app reads environment variables from the shell or hosting platform; it does not load `.env` files by itself.

Halt/feed cache data is stored on the server in `data/store.json`.

User-specific data is stored client-side in each browser:

- Control Center alert settings
- Search and filter selections
- Per-symbol alert toggles
- Already-sent browser alert IDs

This keeps preferences per-user if the app is deployed for multiple users.

## Repository Notes

The following paths are intentionally ignored and should not be committed:

- `node_modules/`: installed dependencies
- `dist/`: generated production build
- `data/`: local runtime feed cache
- `.env`: local environment overrides
- `*.log`: local logs

The package lock file is committed so installs are reproducible.

## Deployment Notes

- Run `npm run build` before `npm start`.
- Set `NODE_ENV=production` when serving the built app.
- Respect NASDAQ Trader feed usage limits. The default poll interval is one minute.
- The `/api/poll-now` endpoint triggers an immediate feed poll. If the app is exposed publicly, consider protecting this endpoint or adding rate limiting.

## License

MIT. See `LICENSE`.
