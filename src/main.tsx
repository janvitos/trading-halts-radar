import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppState, HaltRecord, Settings } from './types';
import './styles.css';

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: '2-digit'
});

const FILTERS_STORAGE_KEY = 'trading-halts-dashboard:filters';
const SETTINGS_STORAGE_KEY = 'trading-halts-dashboard:settings';
const SYMBOL_ALERTS_STORAGE_KEY = 'trading-halts-dashboard:symbol-alerts';
const LEGACY_WATCHLIST_STORAGE_KEY = 'trading-halts-dashboard:watchlist';

const DEFAULT_CLIENT_SETTINGS: Settings = {
  alertAllVolatility: false,
  alertOnHalt: true,
  alertOnResumption: true,
  browserNotifications: true,
  soundAlerts: false,
  resumptionLeadTimesSec: [120, 60, 30, 10],
  predictionWindowsMin: [5, 10, 20]
};

type StoredFilters = {
  query: string;
  volOnly: boolean;
  activeOnly: boolean;
};

function readStoredFilters(): StoredFilters {
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) || '{}') as Partial<StoredFilters>;
    return {
      query: typeof parsed.query === 'string' ? parsed.query : '',
      volOnly: Boolean(parsed.volOnly),
      activeOnly: Boolean(parsed.activeOnly)
    };
  } catch {
    return { query: '', volOnly: false, activeOnly: false };
  }
}

function readStoredSettings(): Settings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}') as Partial<Settings>;
    return {
      ...DEFAULT_CLIENT_SETTINGS,
      ...parsed,
      resumptionLeadTimesSec: Array.isArray(parsed.resumptionLeadTimesSec) ? parsed.resumptionLeadTimesSec : DEFAULT_CLIENT_SETTINGS.resumptionLeadTimesSec,
      predictionWindowsMin: Array.isArray(parsed.predictionWindowsMin) ? parsed.predictionWindowsMin : DEFAULT_CLIENT_SETTINGS.predictionWindowsMin
    };
  } catch {
    return DEFAULT_CLIENT_SETTINGS;
  }
}

function readStoredSymbolAlerts(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SYMBOL_ALERTS_STORAGE_KEY) || localStorage.getItem(LEGACY_WATCHLIST_STORAGE_KEY) || '{}';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([symbol]) => [symbol.trim().toUpperCase().replace('/', '.'), true])
        .filter(([symbol]) => Boolean(symbol))
    );
  } catch {
    return {};
  }
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function formatIso(iso: string | null | undefined, fallback = '-') {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return fallback;
  return ET_FORMATTER.format(date);
}

function formatIsoDate(iso: string | null | undefined) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return DATE_FORMATTER.format(date);
}

function formatSeconds(seconds: number) {
  const sign = seconds < 0 ? '-' : '';
  const absolute = Math.abs(seconds);
  const minutes = Math.floor(absolute / 60);
  const secs = absolute % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${sign}${hours}h ${minutes % 60}m`;
  }
  return `${sign}${minutes}:${String(secs).padStart(2, '0')}`;
}

function targetFor(record: HaltRecord) {
  return record.tradeResumeAt || record.prediction.targetAt;
}

function targetKind(record: HaltRecord) {
  if (record.tradeResumeAt) return 'Official';
  if (record.prediction.targetAt) return record.prediction.status === 'extended' ? `Predicted ${record.prediction.stageMin}m` : 'Predicted';
  return 'None';
}

function statusLabel(record: HaltRecord) {
  switch (record.status) {
    case 'official_resume_scheduled':
      return 'Official resume set';
    case 'prediction_extended':
      return 'Prediction extended';
    case 'awaiting_official':
      return 'Awaiting official';
    case 'resumed':
      return 'Resumed';
    default:
      return 'Halted';
  }
}

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button className={`toggle ${checked ? 'on' : ''}`} type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      <span className="toggle-label">{label}</span>
    </button>
  );
}

function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch('/api/state')
      .then((response) => response.json())
      .then((data) => mounted && setState(data))
      .catch(() => mounted && setState(null));

    const events = new EventSource('/events');
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = (event) => setState(JSON.parse(event.data));

    return () => {
      mounted = false;
      events.close();
    };
  }, []);

  return { state, connected, setState };
}

function useBrowserAlerts(state: AppState | null, now: number) {
  const sentRef = useRef<Set<string>>(new Set(JSON.parse(localStorage.getItem('sent-alerts') || '[]')));
  const sessionStartRef = useRef(Date.now());

  const persist = () => {
    localStorage.setItem('sent-alerts', JSON.stringify([...sentRef.current].slice(-1_000)));
  };

  const notify = (id: string, title: string, body: string, sound: boolean) => {
    if (sentRef.current.has(id)) return;
    sentRef.current.add(id);
    persist();

    if (sound) playBeep();
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(title, { body, tag: id, requireInteraction: false });
  };

  useEffect(() => {
    if (!state?.settings.browserNotifications) return;

    for (const record of state.halts) {
      const eligible = (record.isVolatility && state.settings.alertAllVolatility) || Boolean(state.watchedSymbols[record.symbol]);
      if (!eligible) continue;

      const firstSeenMs = Date.parse(record.firstSeenAt || '');
      const firstSeenThisSession = Number.isFinite(firstSeenMs) && firstSeenMs >= sessionStartRef.current - 2_000;

      if (state.settings.alertOnHalt && firstSeenThisSession && record.status !== 'resumed') {
        const predicted = record.prediction.targetAt ? `\nPredicted resume: ${formatIso(record.prediction.targetAt)} ET` : '';
        notify(
          `${record.id}:halt`,
          `${record.symbol} halt detected`,
          `${record.reasonCode} - ${record.reasonLabel}\nHalt: ${record.haltTime} ET${predicted}`,
          state.settings.soundAlerts
        );
      }

      if (!state.settings.alertOnResumption) continue;

      if (record.tradeResumeAt && Date.parse(record.tradeResumeAt) > now) {
        notify(
          `${record.id}:official:${record.tradeResumeAt}`,
          `${record.symbol} official resume scheduled`,
          `Trade resume: ${formatIso(record.tradeResumeAt)} ET\nQuote resume: ${formatIso(record.quoteResumeAt)} ET`,
          state.settings.soundAlerts
        );
      }

      if (record.prediction.status === 'extended' && record.prediction.targetAt) {
        notify(
          `${record.id}:extended:${record.prediction.stageMin}`,
          `${record.symbol} prediction extended`,
          `No official resume yet. New predicted resume: ${formatIso(record.prediction.targetAt)} ET`,
          state.settings.soundAlerts
        );
      }

      const target = targetFor(record);
      if (!target) continue;
      const remainingSec = Math.ceil((Date.parse(target) - now) / 1_000);
      for (const lead of state.settings.resumptionLeadTimesSec) {
        if (remainingSec <= lead && remainingSec >= -2) {
          notify(
            `${record.id}:resume:${target}:${lead}`,
            `${record.symbol} resume approaching`,
            `${targetKind(record)} resume: ${formatIso(target)} ET\n${formatSeconds(Math.max(0, remainingSec))} remaining`,
            state.settings.soundAlerts
          );
        }
      }
    }
  }, [state, now]);
}

function playBeep() {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.05;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
  } catch {
    // Audio alerts are optional; ignore autoplay/device restrictions.
  }
}

function FeedStatusCard({ state, connected, now, mobileSettingsOpen, onToggleSettings }: { state: AppState; connected: boolean; now: number; mobileSettingsOpen: boolean; onToggleSettings: () => void }) {
  const nextPoll = state.feed.nextPollAt ? Math.max(0, Math.ceil((Date.parse(state.feed.nextPollAt) - now) / 1_000)) : null;
  return (
    <section className="panel feed-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Live Monitor</p>
          <h2>Trading Halts Radar</h2>
        </div>
        <button className={`mobile-settings-button ${mobileSettingsOpen ? 'open' : ''}`} type="button" aria-label={mobileSettingsOpen ? 'Close alert settings' : 'Open alert settings'} onClick={onToggleSettings}>
          <span />
          <span />
          <span />
        </button>
      </div>
      <div className="feed-grid">
        <Metric label="Status" value={state.feed.status} tone={state.feed.status === 'error' ? 'danger' : connected ? 'success' : 'warning'} />
        <Metric label="Last success" value={formatIso(state.feed.lastSuccessAt, 'Waiting')} />
        <Metric label="Next poll" value={nextPoll === null ? '-' : `${nextPoll}s`} />
        <Metric label="Halts" value={String(state.feed.itemCount || 0)} />
      </div>
      {state.feed.lastError && <p className="error-line">{state.feed.lastError}</p>}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div className={`metric ${tone || ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingsPanel({ state, setSettings }: { state: AppState; setSettings: React.Dispatch<React.SetStateAction<Settings>> }) {
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));

  const update = (partial: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...partial }));
  };

  const requestPermission = async () => {
    if (!('Notification' in window)) return;
    const result = await Notification.requestPermission();
    setPermission(result);
  };

  return (
    <section className="panel settings-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Alerts</p>
          <h2>Control Center</h2>
        </div>
        <span className={`pill ${permission === 'granted' ? 'success' : 'warning'}`}>{permission}</span>
      </div>

      <div className="toggle-stack">
        <Toggle checked={state.settings.alertAllVolatility} onChange={(checked) => update({ alertAllVolatility: checked })} label="Alert all volatility halts" />
        <Toggle checked={state.settings.alertOnHalt} onChange={(checked) => update({ alertOnHalt: checked })} label="Alert on halt" />
        <Toggle checked={state.settings.alertOnResumption} onChange={(checked) => update({ alertOnResumption: checked })} label="Alert on resumption" />
        <Toggle checked={state.settings.browserNotifications} onChange={(checked) => update({ browserNotifications: checked })} label="Browser notifications" />
        <Toggle checked={state.settings.soundAlerts} onChange={(checked) => update({ soundAlerts: checked })} label="Sound alerts" />
      </div>

      {permission !== 'granted' && permission !== 'unsupported' && (
        <button className="primary-action" type="button" onClick={requestPermission}>Enable browser notifications</button>
      )}

      <div className="settings-note">
        Alerts are active while this dashboard tab is open. Volatility predictions use {state.settings.predictionWindowsMin.join('m, ')}m windows; official trade resume overrides predictions.
      </div>
    </section>
  );
}

function HaltTable({ records, state, setWatchedSymbols, now }: { records: HaltRecord[]; state: AppState; setWatchedSymbols: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; now: number }) {
  const toggleWatch = (record: HaltRecord, checked: boolean) => {
    setWatchedSymbols((current) => {
      const next = { ...current };
      if (checked) next[record.symbol] = true;
      else delete next[record.symbol];
      return next;
    });
  };

  if (records.length === 0) {
    return <section className="panel empty-state"><h2>No halts match the current filters.</h2><p>The feed may still be loading, or no matching halts are present.</p></section>;
  }

  return (
    <section className="panel halts-panel">
      <div className="table-wrap">
        <table className="halts-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Reason</th>
              <th>Halt</th>
              <th>Predicted</th>
              <th>Official Trade</th>
              <th>Countdown</th>
              <th>Status</th>
              <th>Alert</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => <HaltRow key={record.id} record={record} state={state} now={now} onToggle={toggleWatch} />)}
          </tbody>
        </table>
      </div>
      <div className="halt-cards">
        {records.map((record) => <HaltCard key={record.id} record={record} state={state} now={now} onToggle={toggleWatch} />)}
      </div>
    </section>
  );
}

function CountdownPill({ record, now }: { record: HaltRecord; now: number }) {
  const target = targetFor(record);
  if (!target) return <span className="pill muted">No target</span>;
  const seconds = Math.ceil((Date.parse(target) - now) / 1_000);
  const tone = seconds <= 0 ? 'muted' : seconds <= 30 ? 'danger' : seconds <= 120 ? 'warning' : record.tradeResumeAt ? 'success' : 'accent';
  return <span className={`pill ${tone}`}>{seconds <= 0 ? 'Due now' : formatSeconds(seconds)}</span>;
}

function HaltRow({ record, state, now, onToggle }: { record: HaltRecord; state: AppState; now: number; onToggle: (record: HaltRecord, checked: boolean) => void }) {
  return (
    <tr className={`${record.isVolatility ? 'vol-row' : ''} ${record.watched ? 'watched-row' : ''}`}>
      <td>
        <div className="symbol-cell"><strong>{record.symbol}</strong><span>{record.issueName || record.market}</span></div>
      </td>
      <td><ReasonBadge record={record} /></td>
      <td><TimeCell iso={record.haltAt} raw={record.haltTime} /></td>
      <td>{record.prediction.targetAt ? <TimeCell iso={record.prediction.targetAt} /> : <span className="muted-text">-</span>}</td>
      <td>{record.tradeResumeAt ? <TimeCell iso={record.tradeResumeAt} raw={record.resumptionTradeTime} /> : <span className="muted-text">pending</span>}</td>
      <td><CountdownPill record={record} now={now} /></td>
      <td><span className={`status status-${record.status}`}>{statusLabel(record)}</span></td>
      <td>
        <Toggle checked={state.settings.alertAllVolatility && record.isVolatility ? true : record.watched} disabled={state.settings.alertAllVolatility && record.isVolatility} onChange={(checked) => onToggle(record, checked)} label={record.watched ? 'Disable Alert' : 'Enable Alert'} />
      </td>
    </tr>
  );
}

function HaltCard({ record, state, now, onToggle }: { record: HaltRecord; state: AppState; now: number; onToggle: (record: HaltRecord, checked: boolean) => void }) {
  return (
    <article className={`halt-card ${record.isVolatility ? 'vol-row' : ''} ${record.watched ? 'watched-row' : ''}`}>
      <div className="card-topline">
        <div>
          <strong>{record.symbol}</strong>
          <span>{record.issueName || record.market || 'Trading Halt'}</span>
        </div>
        <CountdownPill record={record} now={now} />
      </div>
      <div className="card-badges">
        <ReasonBadge record={record} />
        <span className={`status status-${record.status}`}>{statusLabel(record)}</span>
      </div>
      <div className="card-grid">
        <Detail label="Halt" value={`${record.haltTime || formatIso(record.haltAt)} ET`} />
        <Detail label="Predicted" value={record.prediction.targetAt ? `${formatIso(record.prediction.targetAt)} ET` : '-'} />
        <Detail label="Quote Resume" value={record.quoteResumeAt ? `${formatIso(record.quoteResumeAt)} ET` : '-'} />
        <Detail label="Trade Resume" value={record.tradeResumeAt ? `${formatIso(record.tradeResumeAt)} ET` : 'pending'} />
      </div>
      <Toggle checked={state.settings.alertAllVolatility && record.isVolatility ? true : record.watched} disabled={state.settings.alertAllVolatility && record.isVolatility} onChange={(checked) => onToggle(record, checked)} label={record.watched ? 'Disable Alert' : 'Enable Alert'} />
    </article>
  );
}

function ReasonBadge({ record }: { record: HaltRecord }) {
  return (
    <span className={`reason-badge ${record.isVolatility ? 'volatility' : ''}`} title={record.reasonLabel}>
      {record.reasonCode || 'N/A'}
    </span>
  );
}

function TimeCell({ iso, raw }: { iso: string | null; raw?: string }) {
  return (
    <div className="time-cell">
      <strong>{raw || formatIso(iso)}</strong>
      <span>{formatIsoDate(iso)} ET</span>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail"><span>{label}</span><strong>{value}</strong></div>;
}

function App() {
  const { state, connected } = useAppState();
  const now = useNow();
  const [filters, setFilters] = useState<StoredFilters>(() => readStoredFilters());
  const [settings, setSettings] = useState<Settings>(() => readStoredSettings());
  const [watchedSymbols, setWatchedSymbols] = useState<Record<string, boolean>>(() => readStoredSymbolAlerts());
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const { query, volOnly, activeOnly } = filters;

  const appState = useMemo(() => (state ? {
    ...state,
    settings,
    watchedSymbols,
    halts: state.halts.map((record) => ({ ...record, watched: Boolean(watchedSymbols[record.symbol]) }))
  } : null), [state, settings, watchedSymbols]);
  useBrowserAlerts(appState, now);

  useEffect(() => {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(SYMBOL_ALERTS_STORAGE_KEY, JSON.stringify(watchedSymbols));
    localStorage.removeItem(LEGACY_WATCHLIST_STORAGE_KEY);
  }, [watchedSymbols]);

  const records = useMemo(() => {
    if (!appState) return [];
    const q = query.trim().toUpperCase();
    return appState.halts.filter((record) => {
      if (volOnly && !record.isVolatility) return false;
      if (activeOnly && record.status === 'resumed') return false;
      if (!q) return true;
      return record.symbol.includes(q) || record.issueName.toUpperCase().includes(q) || record.reasonCode.includes(q);
    });
  }, [appState, query, volOnly, activeOnly]);

  if (!appState) {
    return <main className="loading-screen"><div className="loader" /><h1>Connecting to halt feed...</h1></main>;
  }

  return (
    <>
      <main className="app-shell">
        <section className="top-grid">
          <FeedStatusCard state={appState} connected={connected} now={now} mobileSettingsOpen={mobileSettingsOpen} onToggleSettings={() => setMobileSettingsOpen((open) => !open)} />
        </section>

        <section className="toolbar panel">
          <div className="panel-head toolbar-head">
            <div>
              <p className="eyebrow">Halts</p>
              <h2>{records.length} records</h2>
            </div>
            <button className={`mobile-settings-button toolbar-settings-button ${mobileSettingsOpen ? 'open' : ''}`} type="button" aria-label={mobileSettingsOpen ? 'Close alert settings' : 'Open alert settings'} onClick={() => setMobileSettingsOpen((open) => !open)}>
              <span />
              <span />
              <span />
            </button>
          </div>
          <div className="toolbar-controls">
            <input value={query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} placeholder="Search symbol, company, code" />
            <Toggle checked={volOnly} onChange={(checked) => setFilters((current) => ({ ...current, volOnly: checked }))} label="Volatility only" />
            <Toggle checked={activeOnly} onChange={(checked) => setFilters((current) => ({ ...current, activeOnly: checked }))} label="Active only" />
          </div>
        </section>

        <HaltTable records={records} state={appState} setWatchedSymbols={setWatchedSymbols} now={now} />
      </main>

      <div className={`settings-shell ${mobileSettingsOpen ? 'mobile-open' : ''}`}>
        <button className="settings-backdrop" type="button" aria-label="Close alert settings" onClick={() => setMobileSettingsOpen(false)} />
        <div className="settings-drawer">
          <SettingsPanel state={appState} setSettings={setSettings} />
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
