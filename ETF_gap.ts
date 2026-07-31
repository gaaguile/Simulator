/**
 * Dual Momentum rotation (Antonacci-style) between IYW, IVV, and SHV.
 *
 * Monthly rebalance. At each month-end, compute trailing total return over
 * the lookback window for all three tickers:
 *
 *   - Relative momentum: is IYW's trailing return higher than IVV's?
 *   - Absolute momentum: is the leader's trailing return also higher than
 *     SHV's (the cash/T-bill proxy)? If neither equity beats cash, sit in
 *     SHV instead of forcing a choice between two weak options.
 *
 * Rule per month:
 *   hold IYW  if retIYW > retIVV  AND  retIYW > retSHV
 *   hold IVV  if retIVV > retIYW  AND  retIVV > retSHV
 *   hold SHV  otherwise (both equities underperforming cash)
 *
 * Runs two lookback variants (6-month and 12-month, the two most commonly
 * studied windows in the momentum literature) and compares each against
 * static buy-and-hold IYW and static buy-and-hold IVV.
 *
 * Run locally (Node 18+):
 *   npm install -D typescript tsx @types/node
 *   npx tsx dual-momentum-backtest.ts
 */

const TICKER_IYW = "IYW";
const TICKER_IVV = "IVV";
const TICKER_SHV = "SHV";
const FETCH_FROM = "2008-06-01"; // buffer so a 12-month lookback is valid by the first 2010 rebalance
const REPORT_FROM = "2010-01-01";
const INITIAL_CAPITAL = 20000;
const LOOKBACKS_MONTHS = [6, 12];

interface DailyBar {
  date: Date;
  close: number; // dividend/split-adjusted
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
  const adjclose: number[] = result.indicators.adjclose[0].adjclose;

  const bars: DailyBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = adjclose[i];
    if (c == null) continue;
    bars.push({ date: new Date(timestamps[i] * 1000), close: c });
  }
  return bars.sort((a, b) => a.date.getTime() - b.date.getTime());
}

interface MonthlyBar {
  monthKey: string;
  date: Date;
  close: number;
}

function toMonthly(daily: DailyBar[]): MonthlyBar[] {
  const months = new Map<string, DailyBar[]>();
  for (const bar of daily) {
    const key = `${bar.date.getUTCFullYear()}-${String(bar.date.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!months.has(key)) months.set(key, []);
    months.get(key)!.push(bar);
  }
  const monthly: MonthlyBar[] = [];
  for (const [key, bars] of months) {
    bars.sort((a, b) => a.date.getTime() - b.date.getTime());
    monthly.push({
      monthKey: key,
      date: bars[bars.length - 1].date,
      close: bars[bars.length - 1].close,
    });
  }
  return monthly.sort((a, b) => a.date.getTime() - b.date.getTime());
}

interface CombinedBar {
  monthKey: string;
  date: Date;
  iyw: number;
  ivv: number;
  shv: number;
}

function mergeMonthly(
  iyw: MonthlyBar[],
  ivv: MonthlyBar[],
  shv: MonthlyBar[],
): CombinedBar[] {
  const ivvMap = new Map(ivv.map((b) => [b.monthKey, b]));
  const shvMap = new Map(shv.map((b) => [b.monthKey, b]));
  const combined: CombinedBar[] = [];
  for (const i of iyw) {
    const v = ivvMap.get(i.monthKey);
    const s = shvMap.get(i.monthKey);
    if (v && s)
      combined.push({
        monthKey: i.monthKey,
        date: i.date,
        iyw: i.close,
        ivv: v.close,
        shv: s.close,
      });
  }
  return combined.sort((a, b) => a.date.getTime() - b.date.getTime());
}

type Holding = "IYW" | "IVV" | "SHV";

function priceOf(bar: CombinedBar, h: Holding): number {
  return h === "IYW" ? bar.iyw : h === "IVV" ? bar.ivv : bar.shv;
}

interface Transition {
  date: Date;
  from: Holding;
  to: Holding;
}

interface RotationResult {
  valueSeries: { date: Date; value: number }[];
  holdingHistory: Holding[];
  transitions: Transition[];
  finalHolding: Holding;
}

function runDualMomentum(
  combined: CombinedBar[],
  startIdx: number,
  lookbackMonths: number,
): RotationResult {
  let holding: Holding = "SHV";
  let units = 0;
  let initialized = false;
  const valueSeries: { date: Date; value: number }[] = [];
  const holdingHistory: Holding[] = [];
  const transitions: Transition[] = [];

  for (let i = startIdx; i < combined.length; i++) {
    const bar = combined[i];
    const prevBar = combined[i - lookbackMonths];
    const retIyw = bar.iyw / prevBar.iyw - 1;
    const retIvv = bar.ivv / prevBar.ivv - 1;
    const retShv = bar.shv / prevBar.shv - 1;

    let target: Holding;
    if (retIyw > retIvv && retIyw > retShv) target = "IYW";
    else if (retIvv > retIyw && retIvv > retShv) target = "IVV";
    else target = "SHV";

    if (!initialized) {
      units = INITIAL_CAPITAL / priceOf(bar, target);
      holding = target;
      initialized = true;
    } else if (target !== holding) {
      const cashValue = units * priceOf(bar, holding);
      units = cashValue / priceOf(bar, target);
      transitions.push({ date: bar.date, from: holding, to: target });
      holding = target;
    }

    valueSeries.push({ date: bar.date, value: units * priceOf(bar, holding) });
    holdingHistory.push(holding);
  }

  return { valueSeries, holdingHistory, transitions, finalHolding: holding };
}

function staticBuyHold(
  combined: CombinedBar[],
  startIdx: number,
  ticker: "iyw" | "ivv",
): { date: Date; value: number }[] {
  const units = INITIAL_CAPITAL / combined[startIdx][ticker];
  return combined
    .slice(startIdx)
    .map((b) => ({ date: b.date, value: units * b[ticker] }));
}

function maxDrawdown(values: number[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
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

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function pctOfMonths(history: Holding[], h: Holding): string {
  const count = history.filter((x) => x === h).length;
  return `${((count / history.length) * 100).toFixed(0)}%`;
}

function reportSeries(label: string, series: { date: Date; value: number }[]) {
  const startDate = series[0].date;
  const endDate = series[series.length - 1].date;
  const finalValue = series[series.length - 1].value;
  const dd = maxDrawdown(series.map((s) => s.value));
  console.log(`${label}`);
  console.log(`  Final value  : ${fmtUsd(finalValue)}`);
  console.log(
    `  Total return : ${((finalValue / INITIAL_CAPITAL - 1) * 100).toFixed(1)}%`,
  );
  console.log(
    `  CAGR         : ${(cagr(finalValue, INITIAL_CAPITAL, startDate, endDate) * 100).toFixed(2)}%`,
  );
  console.log(`  Max drawdown : ${(dd * 100).toFixed(1)}%`);
}

async function main() {
  const [iywDaily, ivvDaily, shvDaily] = await Promise.all([
    fetchDailyAdjusted(TICKER_IYW),
    fetchDailyAdjusted(TICKER_IVV),
    fetchDailyAdjusted(TICKER_SHV),
  ]);

  const combined = mergeMonthly(
    toMonthly(iywDaily),
    toMonthly(ivvDaily),
    toMonthly(shvDaily),
  );
  const startIdx = combined.findIndex((b) => b.date >= new Date(REPORT_FROM));
  const maxLookback = Math.max(...LOOKBACKS_MONTHS);
  if (startIdx < maxLookback) {
    throw new Error(
      `Not enough lookback history before ${REPORT_FROM} — push FETCH_FROM further back.`,
    );
  }

  console.log(
    `Dual Momentum rotation: ${TICKER_IYW} / ${TICKER_IVV} / ${TICKER_SHV}`,
  );
  console.log(
    `Window: ${combined[startIdx].date.toISOString().slice(0, 10)} -> ${combined[combined.length - 1].date.toISOString().slice(0, 10)}`,
  );
  console.log(
    `Initial capital: ${fmtUsd(INITIAL_CAPITAL)}, monthly rebalance\n`,
  );

  // Baselines (computed once, same start point for all comparisons)
  const bhIyw = staticBuyHold(combined, startIdx, "iyw");
  const bhIvv = staticBuyHold(combined, startIdx, "ivv");
  reportSeries(`--- Baseline: static buy & hold ${TICKER_IYW} ---`, bhIyw);
  console.log();
  reportSeries(`--- Baseline: static buy & hold ${TICKER_IVV} ---`, bhIvv);

  for (const lookback of LOOKBACKS_MONTHS) {
    const result = runDualMomentum(combined, startIdx, lookback);
    console.log(`\n=== Dual Momentum, ${lookback}-month lookback ===`);
    console.log(`Transitions: ${result.transitions.length}`);
    for (const t of result.transitions) {
      console.log(
        `  ${t.date.toISOString().slice(0, 10)}  ${t.from} -> ${t.to}`,
      );
    }
    console.log(
      `Time held   : ${TICKER_IYW}=${pctOfMonths(result.holdingHistory, "IYW")}  ${TICKER_IVV}=${pctOfMonths(result.holdingHistory, "IVV")}  ${TICKER_SHV}=${pctOfMonths(result.holdingHistory, "SHV")}`,
    );
    console.log(`Currently in: ${result.finalHolding}`);
    reportSeries(`--- Strategy result ---`, result.valueSeries);
  }
}

main();
