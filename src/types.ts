export type FeedStatus = 'starting' | 'polling' | 'ok' | 'error';

export type Prediction = {
  targetAt: string | null;
  stageMin: number | null;
  status: 'official' | 'none' | 'predicted' | 'extended' | 'awaiting_official';
};

export type HaltStatus = 'halted' | 'official_resume_scheduled' | 'prediction_extended' | 'awaiting_official' | 'ended' | 'resumed';

export type HaltRecord = {
  id: string;
  symbol: string;
  issueName: string;
  market: string;
  reasonCode: string;
  reasonLabel: string;
  haltDate: string;
  haltTime: string;
  haltAt: string | null;
  resumptionDate: string;
  resumptionQuoteTime: string;
  resumptionTradeTime: string;
  quoteResumeAt: string | null;
  tradeResumeAt: string | null;
  pauseThresholdPrice: string;
  isVolatility: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  endedAt?: string;
  endedReason?: string;
  prediction: Prediction;
  status: HaltStatus;
  watched: boolean;
};

export type Settings = {
  alertAllVolatility: boolean;
  alertOnHalt: boolean;
  alertOnResumption: boolean;
  browserNotifications: boolean;
  soundAlerts: boolean;
  resumptionLeadTimesSec: number[];
  predictionWindowsMin: number[];
};

export type FeedState = {
  status: FeedStatus;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextPollAt: string | null;
  itemCount: number;
  source: string;
  pubDate?: string;
};

export type AppState = {
  halts: HaltRecord[];
  watchedSymbols: Record<string, boolean>;
  settings: Settings;
  feed: FeedState;
  volatilityCodes: string[];
  serverTime: string;
};
