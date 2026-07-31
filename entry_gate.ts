/**
 * Trend-filter comparison for a $20,000 lump sum in IYW, using a 40-week SMA
 * on weekly closes (the weekly equivalent of Faber's 10-month / 200-day
 * trend rule). Idle cash is parked in SHV, not literal cash.
 *
 * Three variants, all starting from 2010-01-01, all ending today:
 *
 *   1) IMMEDIATE   - invest the full $20k in IYW on day one, never touch it.
 *                    (Same as the earlier lumpsum-backtest.ts baseline.)
 *
 *   2) ENTRY-GATED - park the $20k in SHV until IYW's weekly close first
 *                    trades ABOVE its 40-week SMA, then convert 100% into
 *                    IYW and hold forever (single trade, never exits again).
 *                    This tests "does waiting for trend confirmation before
 *                    deploying a lump sum help or hurt."
 *
 *   3) TREND-FOLLOW - ongoing Faber-style rule: hold IYW whenever its weekly
 *                    close is above the 40-week SMA, hold SHV whenever it's
 *                    below, switching every time the relationship flips.
 *                    This tests "does staying out during downtrends help."
 *
 * Run locally (Node 18+):
 *   npm install -D typescript tsx @types/node
 *   npx tsx trend-backtest.ts
 */

const RISK_TICKER = "IYW";
const CASH_TICKER = "SHV";
const INVESTMENT = 20000;
const FETCH_FROM = "2008-01-01"; // buffer so the 40-week SMA is already valid by 2010
const REPORT_FROM = "2010-01-01";
const SMA_PERIOD_WEEKS = 40;

interface DailyBar {
  date: Date;
  high: number;
  low: number;
  close: number; // dividend/split-adjusted
}

interface WeeklyBar {
  weekKey: string;
  date: Date;
  close: number;
}

async function fetchDailyAdjusted(ticker: string): Promise<DailyBar[]> {
  const period1 = Math.floor(new Date(FETCH_FROM).getTime() / 1000);
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
      high: rawHigh * ratio,
      low: rawLow * ratio,
      close: adjClose,
    });
  }
  return bars.sort((a, b) => a.date.getTime() - b.date.getTime());
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
      close: bars[bars.length - 1].close,
    });
  }
  return weekly.sort((a, b) => a.date.getTime() - b.date.getTime());
}

interface SmaRow extends WeeklyBar {
  sma: number | null;
}

function addSma(weekly: WeeklyBar[], period: number): SmaRow[] {
  return weekly.map((bar, i) => {
    if (i < period - 1) return { ...bar, sma: null };
    const window = weekly.slice(i - period + 1, i + 1);
    const avg = window.reduce((s, w) => s + w.close, 0) / period;
    return { ...bar, sma: avg };
  });
}

interface MergedBar {
  date: Date;
  riskClose: number;
  shvClose: number;
  sma: number | null;
}

function mergeByWeekKey(risk: SmaRow[], shv: WeeklyBar[]): MergedBar[] {
  const shvMap = new Map(shv.map((b) => [b.weekKey, b]));
  const merged: MergedBar[] = [];
  for (const r of risk) {
    const s = shvMap.get(r.weekKey);
    if (!s) continue;
    merged.push({
      date: r.date,
      riskClose: r.close,
      shvClose: s.close,
      sma: r.sma,
    });
  }
  return merged.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function cagr(
  finalValue: number,
  principal: number,
  startDate: Date,
  endDate: Date,
): number {
  const years =
    (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365);
  return Math.pow(finalValue / principal, 1 / years) - 1;
}

async function main() {
  const [riskDaily, shvDaily] = await Promise.all([
    fetchDailyAdjusted(RISK_TICKER),
    fetchDailyAdjusted(CASH_TICKER),
  ]);
  const riskWeekly = addSma(toWeekly(riskDaily), SMA_PERIOD_WEEKS);
  const shvWeekly = toWeekly(shvDaily);
  const allBars = mergeByWeekKey(riskWeekly, shvWeekly);
  const bars = allBars.filter(
    (b) => b.date >= new Date(REPORT_FROM) && b.sma != null,
  );

  if (bars.length === 0)
    throw new Error(
      "No bars with a valid 40-week SMA after REPORT_FROM — extend FETCH_FROM further back.",
    );

  const startDate = bars[0].date;
  const finalBar = bars[bars.length - 1];

  console.log(
    `${RISK_TICKER} trend-filter comparison, ${fmtUsd(INVESTMENT)} lump sum, ${startDate.toISOString().slice(0, 10)} -> ${finalBar.date.toISOString().slice(0, 10)}`,
  );
  console.log(
    `Trend filter: 40-week SMA on weekly closes. Idle cash parked in ${CASH_TICKER}.\n`,
  );

  // --- 1) IMMEDIATE ---
  {
    const units = INVESTMENT / bars[0].riskClose;
    const finalValue = units * finalBar.riskClose;
    console.log(`--- 1) Immediate lump sum ---`);
    console.log(
      `  Entry: ${startDate.toISOString().slice(0, 10)} @ $${bars[0].riskClose.toFixed(2)}`,
    );
    console.log(`  Final value  : ${fmtUsd(finalValue)}`);
    console.log(
      `  Total return : ${((finalValue / INVESTMENT - 1) * 100).toFixed(1)}%`,
    );
    console.log(
      `  CAGR         : ${(cagr(finalValue, INVESTMENT, startDate, finalBar.date) * 100).toFixed(2)}%\n`,
    );
  }

  // --- 2) ENTRY-GATED (wait for first close above 40-wk SMA, then buy & hold forever) ---
  {
    let entryBar: MergedBar | null = null;
    for (const bar of bars) {
      if (bar.sma != null && bar.riskClose > bar.sma) {
        entryBar = bar;
        break;
      }
    }
    if (!entryBar) {
      console.log(
        `--- 2) Entry-gated (40-wk SMA reclaim) ---\n  Never triggered in this window.\n`,
      );
    } else {
      // cash accrues in SHV from startDate until entryBar, then converts fully into the risk ticker
      const shvUnits = INVESTMENT / bars[0].shvClose;
      const cashAtEntry = shvUnits * entryBar.shvClose;
      const riskUnits = cashAtEntry / entryBar.riskClose;
      const finalValue = riskUnits * finalBar.riskClose;
      console.log(
        `--- 2) Entry-gated (wait for close above 40-wk SMA, then hold forever) ---`,
      );
      console.log(
        `  Waited in ${CASH_TICKER} from ${startDate.toISOString().slice(0, 10)} to ${entryBar.date.toISOString().slice(0, 10)}`,
      );
      console.log(
        `  Entry: ${entryBar.date.toISOString().slice(0, 10)} @ $${entryBar.riskClose.toFixed(2)} (value at entry: ${fmtUsd(cashAtEntry)})`,
      );
      console.log(`  Final value  : ${fmtUsd(finalValue)}`);
      console.log(
        `  Total return : ${((finalValue / INVESTMENT - 1) * 100).toFixed(1)}%`,
      );
      console.log(
        `  CAGR         : ${(cagr(finalValue, INVESTMENT, startDate, finalBar.date) * 100).toFixed(2)}%\n`,
      );
    }
  }

  // --- 3) TREND-FOLLOW (continuously in risk ticker above SMA, in SHV below, forever) ---
  {
    let unitsRisk = 0;
    let unitsShv = 0;
    let inRisk = bars[0].riskClose > (bars[0].sma as number);
    if (inRisk) unitsRisk = INVESTMENT / bars[0].riskClose;
    else unitsShv = INVESTMENT / bars[0].shvClose;

    const switches: { date: Date; direction: "TO_RISK" | "TO_CASH" }[] = [];

    for (let i = 1; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.sma == null) continue;
      const shouldBeInRisk = bar.riskClose > bar.sma;
      if (shouldBeInRisk !== inRisk) {
        if (shouldBeInRisk) {
          const cashValue = unitsShv * bar.shvClose;
          unitsRisk = cashValue / bar.riskClose;
          unitsShv = 0;
          switches.push({ date: bar.date, direction: "TO_RISK" });
        } else {
          const cashValue = unitsRisk * bar.riskClose;
          unitsShv = cashValue / bar.shvClose;
          unitsRisk = 0;
          switches.push({ date: bar.date, direction: "TO_CASH" });
        }
        inRisk = shouldBeInRisk;
      }
    }

    const finalValue =
      unitsRisk * finalBar.riskClose + unitsShv * finalBar.shvClose;
    console.log(
      `--- 3) Continuous trend-following (40-wk SMA, switches both ways) ---`,
    );
    console.log(`  Switches: ${switches.length}`);
    for (const s of switches) {
      console.log(
        `    ${s.date.toISOString().slice(0, 10)}  ${s.direction === "TO_RISK" ? `${CASH_TICKER} -> ${RISK_TICKER}` : `${RISK_TICKER} -> ${CASH_TICKER}`}`,
      );
    }
    console.log(`  Ending state : ${inRisk ? RISK_TICKER : CASH_TICKER}`);
    console.log(`  Final value  : ${fmtUsd(finalValue)}`);
    console.log(
      `  Total return : ${((finalValue / INVESTMENT - 1) * 100).toFixed(1)}%`,
    );
    console.log(
      `  CAGR         : ${(cagr(finalValue, INVESTMENT, startDate, finalBar.date) * 100).toFixed(2)}%\n`,
    );
  }
}

main();
