/**
 * One-way sweep backtest: save $2,000/month into SHV (cash-equivalent).
 * Whenever a risk ETF's weekly Full Stochastic(14,3,3) %D line freshly
 * crosses BELOW 20, sweep 100% of whatever has accrued in SHV (contributions
 * + SHV's own yield since the last sweep) into that ETF as a permanent buy —
 * it is never sold. When %D crosses back ABOVE 20 nothing happens except
 * that new monthly contributions keep piling up in SHV, waiting for the next
 * signal. So the risk-ETF position only ever grows, one lump sum per
 * oversold signal. %D (the smoothed signal line) is used rather than %K to
 * cut down on whipsaw triggers from single-week noise.
 *
 * Runs one independent simulation per risk ticker (DIA, IVV, IYW), each
 * against its own SHV cash leg, plus two baselines for context:
 *   - Pure SHV DCA (never touches equities)
 *   - Pure DCA straight into the risk ticker (never touches SHV)
 *
 * Run locally (Node 18+):
 *   npm install -D typescript tsx @types/node
 *   npx tsx rotation-backtest.ts
 */

const CASH_TICKER = "SHV";
const RISK_TICKERS = ["DIA", "IVV", "IYW", "IYF"];
const START_DATE = "2009-11-01"; // lookback so first weekly stoch(14,3,3) is valid by 2010
const REPORT_FROM = "2010-01-01";
const STOCH_K_PERIOD = 14;
const STOCH_K_SMOOTH = 3;
const STOCH_D_SMOOTH = 3;
const OVERSOLD_LEVEL = 20;
const MONTHLY_CONTRIBUTION = 2000;

interface DailyBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number; // dividend/split-adjusted
}

interface WeeklyBar {
  weekKey: string; // ISO Monday-of-week key, used to align series across tickers
  date: Date;
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

    const ratio = adjClose / rawClose;
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

function weekKeyOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - day);
  return monday.toISOString().slice(0, 10);
}

function toWeekly(daily: DailyBar[]): WeeklyBar[] {
  const weeks = new Map<string, DailyBar[]>();
  for (const bar of daily) {
    const key = weekKeyOf(bar.date);
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key)!.push(bar);
  }

  const weekly: WeeklyBar[] = [];
  for (const [key, bars] of weeks) {
    bars.sort((a, b) => a.date.getTime() - b.date.getTime());
    weekly.push({
      weekKey: key,
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
    if (highN === lowN) return 50;
    return (100 * (bar.close - lowN)) / (highN - lowN);
  });
  const fullK = rawK.map((_, i) => sma(rawK, STOCH_K_SMOOTH, i));
  const fullD = fullK.map((_, i) => sma(fullK, STOCH_D_SMOOTH, i));
  return weekly.map((bar, i) => ({ ...bar, k: fullK[i], d: fullD[i] }));
}

// Money-weighted annualized return (XIRR) via bisection.
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

interface MergedBar {
  weekKey: string;
  date: Date;
  shvClose: number;
  riskClose: number;
  d: number | null;
}

function mergeByWeekKey(shv: WeeklyBar[], risk: StochRow[]): MergedBar[] {
  const shvMap = new Map(shv.map((b) => [b.weekKey, b]));
  const merged: MergedBar[] = [];
  for (const r of risk) {
    const s = shvMap.get(r.weekKey);
    if (!s) continue;
    merged.push({
      weekKey: r.weekKey,
      date: r.date,
      shvClose: s.close,
      riskClose: r.close,
      d: r.d,
    });
  }
  return merged.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

async function runRotationBacktest(riskTicker: string, shvWeekly: WeeklyBar[]) {
  const riskDaily = await fetchDailyAdjusted(riskTicker);
  const riskWeeklyAll = toWeekly(riskDaily);
  const riskStochAll = fullStochastic(riskWeeklyAll);
  const mergedAll = mergeByWeekKey(shvWeekly, riskStochAll);
  const merged = mergedAll.filter((b) => b.date >= new Date(REPORT_FROM));

  if (merged.length < STOCH_K_PERIOD + STOCH_K_SMOOTH + STOCH_D_SMOOTH) {
    console.log(
      `${riskTicker}: insufficient overlapping data with ${CASH_TICKER}.`,
    );
    return;
  }

  let unitsShv = 0;
  let unitsRisk = 0;
  let lastContribMonthKey = "";
  let totalContributed = 0;
  const contribCashflows: { date: Date; amount: number }[] = [];
  const sweeps: { date: Date; d: number; amountSwept: number }[] = [];

  // baselines
  let bhShvUnits = 0; // pure SHV DCA
  let bhRiskUnits = 0; // pure risk-ticker DCA

  for (let i = 0; i < merged.length; i++) {
    const bar = merged[i];
    const monthKey = `${bar.date.getUTCFullYear()}-${bar.date.getUTCMonth()}`;

    if (monthKey !== lastContribMonthKey) {
      // contributions always land in SHV; sweeps (below) move accrued cash into the risk ETF
      unitsShv += MONTHLY_CONTRIBUTION / bar.shvClose;

      bhShvUnits += MONTHLY_CONTRIBUTION / bar.shvClose;
      bhRiskUnits += MONTHLY_CONTRIBUTION / bar.riskClose;

      totalContributed += MONTHLY_CONTRIBUTION;
      contribCashflows.push({ date: bar.date, amount: -MONTHLY_CONTRIBUTION });
      lastContribMonthKey = monthKey;
    }

    if (i > 0) {
      const prevD = merged[i - 1].d;
      const curD = bar.d;
      if (
        prevD != null &&
        curD != null &&
        prevD >= OVERSOLD_LEVEL &&
        curD < OVERSOLD_LEVEL &&
        unitsShv > 0
      ) {
        const cashValue = unitsShv * bar.shvClose;
        unitsRisk += cashValue / bar.riskClose;
        unitsShv = 0;
        sweeps.push({ date: bar.date, d: curD, amountSwept: cashValue });
      }
      // curD crossing back above 20 triggers no action: contributions already
      // default to SHV, so "resume saving in SHV" is automatic, not a transition.
    }
  }

  const finalBar = merged[merged.length - 1];
  const finalValue =
    unitsShv * finalBar.shvClose + unitsRisk * finalBar.riskClose;
  const strategyCashflows = [
    ...contribCashflows,
    { date: finalBar.date, amount: finalValue },
  ];
  const strategyIrr = xirr(strategyCashflows);

  const bhShvFinalValue = bhShvUnits * finalBar.shvClose;
  const bhShvCashflows = [
    ...contribCashflows,
    { date: finalBar.date, amount: bhShvFinalValue },
  ];
  const bhShvIrr = xirr(bhShvCashflows);

  const bhRiskFinalValue = bhRiskUnits * finalBar.riskClose;
  const bhRiskCashflows = [
    ...contribCashflows,
    { date: finalBar.date, amount: bhRiskFinalValue },
  ];
  const bhRiskIrr = xirr(bhRiskCashflows);

  console.log(`\n=== ${riskTicker} (funded by ${CASH_TICKER} savings) ===`);
  console.log(
    `Window                 : ${merged[0].date.toISOString().slice(0, 10)} -> ${finalBar.date.toISOString().slice(0, 10)}`,
  );
  console.log(
    `Monthly contribution   : ${fmtUsd(MONTHLY_CONTRIBUTION)}  |  Total contributed: ${fmtUsd(totalContributed)}`,
  );
  console.log(`Sweeps into ${riskTicker}          : ${sweeps.length}`);
  for (const s of sweeps) {
    console.log(
      `  ${s.date.toISOString().slice(0, 10)}  SHV -> ${riskTicker}  ${fmtUsd(s.amountSwept)}  (%D=${s.d.toFixed(1)})`,
    );
  }
  console.log(
    `Ending SHV balance     : ${fmtUsd(unitsShv * finalBar.shvClose)}  (waiting for next signal)`,
  );
  console.log(`--- Strategy (sweep on oversold, buy & hold) ---`);
  console.log(
    `Final value            : ${fmtUsd(finalValue)}  |  Total return: ${((finalValue / totalContributed - 1) * 100).toFixed(1)}%  |  Money-wtd IRR: ${(strategyIrr * 100).toFixed(2)}%`,
  );
  console.log(`--- Baseline: pure ${CASH_TICKER} DCA (never invests) ---`);
  console.log(
    `Final value            : ${fmtUsd(bhShvFinalValue)}  |  Total return: ${((bhShvFinalValue / totalContributed - 1) * 100).toFixed(1)}%  |  Money-wtd IRR: ${(bhShvIrr * 100).toFixed(2)}%`,
  );
  console.log(`--- Baseline: pure ${riskTicker} DCA (always invested) ---`);
  console.log(
    `Final value            : ${fmtUsd(bhRiskFinalValue)}  |  Total return: ${((bhRiskFinalValue / totalContributed - 1) * 100).toFixed(1)}%  |  Money-wtd IRR: ${(bhRiskIrr * 100).toFixed(2)}%`,
  );
}

async function main() {
  const shvDaily = await fetchDailyAdjusted(CASH_TICKER);
  const shvWeekly = toWeekly(shvDaily);

  for (const ticker of RISK_TICKERS) {
    try {
      await runRotationBacktest(ticker, shvWeekly);
    } catch (err) {
      console.error(`${ticker} failed:`, err);
    }
  }
}

main();
