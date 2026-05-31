import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { DateTime } from 'luxon';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const storePath = path.join(dataDir, 'store.json');

const PORT = Number(process.env.THR_PORT || 8787);
const RSS_URL = process.env.HALT_RSS_URL || 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
const ET_ZONE = 'America/New_York';
const VOLATILITY_CODES = new Set(['LUDP', 'LUDS', 'M', 'T5', 'T7']);

const defaultSettings = {
  alertAllVolatility: false,
  alertOnHalt: true,
  alertOnResumption: true,
  browserNotifications: true,
  soundAlerts: false,
  resumptionLeadTimesSec: [120, 60, 30, 10],
  predictionWindowsMin: [5, 10, 20]
};

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true
});

let store = {
  halts: {},
  feed: {
    status: 'starting',
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    nextPollAt: null,
    itemCount: 0,
    source: RSS_URL
  }
};

let saveTimer = null;
const clients = new Set();

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeSymbol(symbol) {
  return clean(symbol).toUpperCase().replace('/', '.');
}

function parseEt(dateText, timeText) {
  const date = clean(dateText);
  const time = clean(timeText);
  if (!date || !time) return null;

  const formats = time.includes('.') ? ['MM/dd/yyyy HH:mm:ss.SSS', 'M/d/yyyy HH:mm:ss.SSS'] : ['MM/dd/yyyy HH:mm:ss', 'M/d/yyyy HH:mm:ss'];
  for (const fmt of formats) {
    const parsed = DateTime.fromFormat(`${date} ${time}`, fmt, { zone: ET_ZONE });
    if (parsed.isValid) return parsed.toUTC().toISO();
  }
  return null;
}

function haltId(record) {
  return [record.symbol, record.haltDate, record.haltTime, record.reasonCode].join('|');
}

function reasonLabel(code) {
  const labels = {
    LUDP: 'Volatility Trading Pause',
    LUDS: 'Volatility Pause - Straddle',
    M: 'Volatility Trading Pause',
    T5: 'Single Stock Trading Pause',
    T7: 'Quotation-Only Period',
    T1: 'News Pending',
    T2: 'News Released',
    T3: 'News and Resumption Times',
    H10: 'SEC Trading Suspension'
  };
  return labels[code] || 'Trading Halt';
}

function normalizeItem(item) {
  const symbol = normalizeSymbol(item.IssueSymbol || item.title);
  const haltDate = clean(item.HaltDate);
  const haltTime = clean(item.HaltTime);
  const reasonCode = clean(item.ReasonCode).toUpperCase();
  const resumptionDate = clean(item.ResumptionDate);
  const resumptionQuoteTime = clean(item.ResumptionQuoteTime);
  const resumptionTradeTime = clean(item.ResumptionTradeTime);

  if (!symbol || !haltDate || !haltTime) return null;

  const record = {
    id: '',
    symbol,
    issueName: clean(item.IssueName),
    market: clean(item.Market || item.Mkt),
    reasonCode,
    reasonLabel: reasonLabel(reasonCode),
    haltDate,
    haltTime,
    haltAt: parseEt(haltDate, haltTime),
    resumptionDate,
    resumptionQuoteTime,
    resumptionTradeTime,
    quoteResumeAt: parseEt(resumptionDate, resumptionQuoteTime),
    tradeResumeAt: parseEt(resumptionDate, resumptionTradeTime),
    pauseThresholdPrice: clean(item.PauseThresholdPrice),
    isVolatility: VOLATILITY_CODES.has(reasonCode)
  };
  record.id = haltId(record);
  return record;
}

function predictionFor(record, nowMs = Date.now()) {
  if (!record.isVolatility || !record.haltAt || record.tradeResumeAt) {
    return { targetAt: null, stageMin: null, status: record.tradeResumeAt ? 'official' : 'none' };
  }

  const haltMs = Date.parse(record.haltAt);
  const windows = [...defaultSettings.predictionWindowsMin].sort((a, b) => a - b);
  for (const minutes of windows) {
    const targetMs = haltMs + minutes * 60_000;
    if (nowMs < targetMs) {
      return {
        targetAt: new Date(targetMs).toISOString(),
        stageMin: minutes,
        status: minutes === windows[0] ? 'predicted' : 'extended'
      };
    }
  }

  return { targetAt: null, stageMin: null, status: 'awaiting_official' };
}

function statusFor(record, nowMs = Date.now()) {
  if (record.tradeResumeAt && nowMs >= Date.parse(record.tradeResumeAt)) return 'resumed';
  if (record.tradeResumeAt) return 'official_resume_scheduled';
  const prediction = predictionFor(record, nowMs);
  if (prediction.status === 'awaiting_official') return 'awaiting_official';
  if (prediction.status === 'extended') return 'prediction_extended';
  return 'halted';
}

function publicState() {
  const nowMs = Date.now();
  const halts = Object.values(store.halts)
    .map((record) => ({
      ...record,
      prediction: predictionFor(record, nowMs),
      status: statusFor(record, nowMs),
      watched: false
    }))
    .sort((a, b) => Date.parse(b.haltAt || 0) - Date.parse(a.haltAt || 0));

  return {
    halts,
    watchedSymbols: {},
    settings: defaultSettings,
    feed: store.feed,
    volatilityCodes: [...VOLATILITY_CODES],
    serverTime: new Date().toISOString()
  };
}

async function loadStore() {
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    store = {
      ...store,
      halts: parsed.halts || {},
      feed: { ...store.feed, ...(parsed.feed || {}), status: 'starting', source: RSS_URL }
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Unable to load store:', error.message);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(store, null, 2));
    } catch (error) {
      console.error('Unable to save store:', error);
    }
  }, 150);
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const response of clients) response.write(payload);
}

function mergeRecords(records) {
  let changed = false;
  const seenAt = new Date().toISOString();

  for (const record of records) {
    const existing = store.halts[record.id];
    if (!existing) {
      store.halts[record.id] = { ...record, firstSeenAt: seenAt, lastSeenAt: seenAt };
      changed = true;
      continue;
    }

    const merged = { ...existing, ...record, firstSeenAt: existing.firstSeenAt, lastSeenAt: seenAt };
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      store.halts[record.id] = merged;
      changed = true;
    } else {
      existing.lastSeenAt = seenAt;
    }
  }

  return changed;
}

async function pollFeed() {
  const pollStartedAt = new Date();
  store.feed = {
    ...store.feed,
    status: 'polling',
    lastPollAt: pollStartedAt.toISOString(),
    nextPollAt: new Date(pollStartedAt.getTime() + POLL_INTERVAL_MS).toISOString()
  };
  broadcast();

  try {
    const response = await fetch(RSS_URL, {
      headers: { 'user-agent': 'trading-halts-dashboard/0.1' }
    });
    if (!response.ok) throw new Error(`RSS request failed: ${response.status} ${response.statusText}`);

    const xml = await response.text();
    const parsed = parser.parse(xml);
    const channel = parsed?.rss?.channel || {};
    const rawItems = channel.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
    const records = rawItems.map(normalizeItem).filter(Boolean);
    const changed = mergeRecords(records);

    store.feed = {
      ...store.feed,
      status: 'ok',
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      itemCount: records.length,
      pubDate: clean(channel.pubDate)
    };

    scheduleSave();
    if (changed) broadcast();
  } catch (error) {
    store.feed = {
      ...store.feed,
      status: 'error',
      lastError: error.message,
      nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS).toISOString()
    };
    console.error('Feed poll failed:', error.message);
    scheduleSave();
    broadcast();
  }
}

await loadStore();

const app = express();
app.use(express.json());

app.get('/api/state', (_req, res) => res.json(publicState()));

app.post('/api/poll-now', async (_req, res) => {
  await pollFeed();
  res.json(publicState());
});

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

const distDir = path.join(rootDir, 'dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/events') return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Trading halts server listening on http://localhost:${PORT}`);
});

pollFeed();
setInterval(pollFeed, POLL_INTERVAL_MS);
setInterval(broadcast, 1_000);
