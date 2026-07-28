/**
 * Weekly Full Stochastic (14,3,3) "buy the oversold dip" backtest — TypeScript.
 *
 * Strategy:
 *   - Pull daily OHLC + adjusted close from Yahoo Finance's chart endpoint.
 *   - Scale High/Low/Close by the daily adjClose/Close ratio, so the whole
 *     OHLC series reflects dividends + splits (total return), same approach
 *     yfinance uses with auto_adjust=True.
 *   - Resample to weekly bars (Fri close).
 *   - Compute Full Stochastic(14,3,3): RawK from 14-wk High/Low, %K = SMA3(RawK),
 *     %D = SMA3(%K).
 *   - Signal = fresh cross: %K < 20 this week, %K >= 20 the prior week.
 *   - On each signal, invest a fixed dollar tranche at that week's close.
 *     Nothing is ever sold. Compare money-weighted IRR of the tranche
 *     strategy vs. a lump-sum buy-and-hold since the first week.
 *
 * Run locally (Node 18+, has built-in fetch):
 *   npm install -D typescript tsx @types/node
 *   npx tsx stochastic-backtest.ts
 */

const TICKERS = ["IVV", "IYW", "DIA"];
const START_DATE = "2009-11-01"; // extra lookback so first weekly stoch(14,3,3) is valid by 2010
const REPORT_FROM = "2010-01-01";
const STOCH_K_PERIOD = 14;
const STOCH_K_SMOOTH = 3;
const STOCH_D_SMOOTH = 3;
const OVERSOLD_LEVEL = 20;
const TRANCHE_USD = 2000;

interface DailyBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number; // dividend/split-adjusted
}

interface WeeklyBar {
  date: Date; // Friday (or last trading day of the week)
  high: number;
  low: number;
  close: number;
}

async function fetchDailyAdjusted(ticker: string): Promise<DailyBar[]> {
  const period1 = Math.floor(new Date(START_DATE).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}` +
    `?period1=${period1}&period2=${period2}&interval=1d&events=div,splits`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; backtest-script/1.0)" },
  });
  if (!res.ok)
    throw new Error(
      `Fetch failed for ${ticker}: ${res.status} ${res.statusText}`,
    );

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result)
    throw new Error(
      `No chart result for ${ticker}: ${JSON.stringify(json?.chart?.error)}`,
    );

  const timestamps: number[] = result.timestamp;
  const quote = result.indicators.quote[0];
  const adjclose: number[] = result.indicators.adjclose[0].adjclose;

  const bars: DailyBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const rawClose = quote.close[i];
    const rawHigh = quote.high[i];
    const rawLow = quote.low[i];
    const adjClose = adjclose[i];
    if (
      rawClose == null ||
      rawHigh == null ||
      rawLow == null ||
      adjClose == null
    )
      continue;

    const ratio = adjClose / rawClose; // folds in dividends + splits
    bars.push({
      date: new Date(timestamps[i] * 1000),
      open: quote.open[i] * ratio,
      high: rawHigh * ratio,
      low: rawLow * ratio,
      close: adjClose,
    });
  }
  return bars;
}

function toWeekly(daily: DailyBar[]): WeeklyBar[] {
  const weeks = new Map<string, DailyBar[]>();
  for (const bar of daily) {
    // ISO week key so Mon-Sun bars group together regardless of holidays
    const d = new Date(bar.date);
    const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - day);
    const key = monday.toISOString().slice(0, 10);
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key)!.push(bar);
  }

  const weekly: WeeklyBar[] = [];
  for (const bars of weeks.values()) {
    bars.sort((a, b) => a.date.getTime() - b.date.getTime());
    weekly.push({
      date: bars[bars.length - 1].date,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
    });
  }
  weekly.sort((a, b) => a.date.getTime() - b.date.getTime());
  return weekly;
}

function sma(
  values: (number | null)[],
  period: number,
  i: number,
): number | null {
  if (i < period - 1) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const v = values[j];
    if (v == null) return null;
    sum += v;
  }
  return sum / period;
}

interface StochRow extends WeeklyBar {
  k: number | null;
  d: number | null;
}

function fullStochastic(weekly: WeeklyBar[]): StochRow[] {
  const rawK: (number | null)[] = weekly.map((bar, i) => {
    if (i < STOCH_K_PERIOD - 1) return null;
    const window = weekly.slice(i - STOCH_K_PERIOD + 1, i + 1);
    const highN = Math.max(...window.map((w) => w.high));
    const lowN = Math.min(...window.map((w) => w.low));
    if (highN === lowN) return 50; // flat range guard
    return (100 * (bar.close - lowN)) / (highN - lowN);
  });

  const fullK = rawK.map((_, i) => sma(rawK, STOCH_K_SMOOTH, i));
  const fullD = fullK.map((_, i) => sma(fullK, STOCH_D_SMOOTH, i));

  return weekly.map((bar, i) => ({ ...bar, k: fullK[i], d: fullD[i] }));
}

// Money-weighted annualized return (XIRR) via bisection on NPV(rate) = 0.
function xirr(cashflows: { date: Date; amount: number }[]): number {
  const t0 = cashflows[0].date.getTime();
  const yearsFrom = (d: Date) =>
    (d.getTime() - t0) / (1000 * 60 * 60 * 24 * 365);

  const npv = (rate: number) =>
    cashflows.reduce(
      (acc, cf) => acc + cf.amount / Math.pow(1 + rate, yearsFrom(cf.date)),
      0,
    );

  let lo = -0.99;
  let hi = 10;
  let flo = npv(lo);
  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(mid);
    if (Math.abs(fmid) < 1e-6) return mid;
    if ((flo < 0 && fmid < 0) || (flo > 0 && fmid > 0)) {
      lo = mid;
      flo = fmid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

async function runBacktest(ticker: string) {
  const daily = await fetchDailyAdjusted(ticker);
  const weeklyAll = toWeekly(daily);
  const stochAll = fullStochastic(weeklyAll);
  const stoch = stochAll.filter((r) => r.date >= new Date(REPORT_FROM));

  const signals: StochRow[] = [];
  for (let i = 1; i < stoch.length; i++) {
    const prevK = stoch[i - 1].k;
    const curK = stoch[i].k;
    if (
      prevK != null &&
      curK != null &&
      prevK >= OVERSOLD_LEVEL &&
      curK < OVERSOLD_LEVEL
    ) {
      signals.push(stoch[i]);
    }
  }

  if (signals.length === 0) {
    console.log(`${ticker}: no signals found in the period.`);
    return;
  }

  const finalClose = stoch[stoch.length - 1].close;
  const units = signals.reduce((sum, s) => sum + TRANCHE_USD / s.close, 0);
  const invested = TRANCHE_USD * signals.length;
  const finalValue = units * finalClose;

  const cashflows = signals.map((s) => ({
    date: s.date,
    amount: -TRANCHE_USD,
  }));
  cashflows.push({ date: stoch[stoch.length - 1].date, amount: finalValue });
  const trancheIrr = xirr(cashflows);
  const trancheTotalReturn = finalValue / invested - 1;

  // Buy-and-hold benchmark: same total dollars, lump sum on the first reported week
  const bhStart = stoch[0];
  const bhUnits = invested / bhStart.close;
  const bhFinalValue = bhUnits * finalClose;
  const years =
    (stoch[stoch.length - 1].date.getTime() - bhStart.date.getTime()) /
    (1000 * 60 * 60 * 24 * 365);
  const bhCagr = Math.pow(bhFinalValue / invested, 1 / years) - 1;

  console.log(`\n=== ${ticker} ===`);
  console.log(
    `Data window used         : ${stoch[0].date.toISOString().slice(0, 10)} -> ${stoch[stoch.length - 1].date.toISOString().slice(0, 10)}`,
  );
  console.log(`Signals (fresh <20 cross): ${signals.length}`);
  console.log(
    `Signal dates             : ${signals.map((s) => s.date.toISOString().slice(0, 10)).join(", ")}`,
  );
  console.log(
    `Total invested           : $${invested.toLocaleString()} ($${TRANCHE_USD} x ${signals.length} tranches)`,
  );
  console.log(
    `Final value              : $${finalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
  );
  console.log(
    `Tranche total return     : ${(trancheTotalReturn * 100).toFixed(1)}%`,
  );
  console.log(
    `Tranche money-wtd IRR    : ${(trancheIrr * 100).toFixed(2)}% annualized`,
  );
  console.log(
    `--- vs. lump-sum buy&hold of $${invested.toLocaleString()} on ${bhStart.date.toISOString().slice(0, 10)} ---`,
  );
  console.log(
    `Buy&hold final value     : $${bhFinalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
  );
  console.log(
    `Buy&hold CAGR            : ${(bhCagr * 100).toFixed(2)}% annualized`,
  );
}

async function main() {
  for (const ticker of TICKERS) {
    try {
      await runBacktest(ticker);
    } catch (err) {
      console.error(`${ticker} failed:`, err);
    }
  }
}

main();
