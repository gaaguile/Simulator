/**
 * Lump-sum comparison: invest $20,000 in IYW on two different start dates,
 * held to today, using total-return (dividend/split-adjusted) prices.
 *
 *   1) First trading day of 2010
 *   2) 2011-06-24
 *
 * Run locally (Node 18+):
 *   npm install -D typescript tsx @types/node
 *   npx tsx lumpsum-backtest.ts
 */

const TICKER = "IYW";
const INVESTMENT = 20000;
const FETCH_FROM = "2009-11-01"; // small buffer before the earliest entry date
const ENTRY_DATES = ["2010-01-01", "2011-06-24"];

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

/** First bar on or after the given date (handles weekends/holidays). */
function firstBarOnOrAfter(bars: DailyBar[], isoDate: string): DailyBar {
  const target = new Date(isoDate).getTime();
  const bar = bars.find((b) => b.date.getTime() >= target);
  if (!bar) throw new Error(`No trading day found on/after ${isoDate}`);
  return bar;
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

async function main() {
  const bars = await fetchDailyAdjusted(TICKER);
  const finalBar = bars[bars.length - 1];

  console.log(
    `${TICKER} lump-sum comparison, ${fmtUsd(INVESTMENT)} each, held to ${finalBar.date.toISOString().slice(0, 10)}`,
  );
  console.log(`Final price: $${finalBar.close.toFixed(2)}\n`);

  for (const isoDate of ENTRY_DATES) {
    const entryBar = firstBarOnOrAfter(bars, isoDate);
    const units = INVESTMENT / entryBar.close;
    const finalValue = units * finalBar.close;
    const totalReturn = finalValue / INVESTMENT - 1;
    const years =
      (finalBar.date.getTime() - entryBar.date.getTime()) /
      (1000 * 60 * 60 * 24 * 365);
    const cagr = Math.pow(finalValue / INVESTMENT, 1 / years) - 1;

    console.log(
      `Entry: ${entryBar.date.toISOString().slice(0, 10)} (requested ${isoDate})`,
    );
    console.log(`  Entry price   : $${entryBar.close.toFixed(2)}`);
    console.log(`  Units bought  : ${units.toFixed(4)}`);
    console.log(`  Final value   : ${fmtUsd(finalValue)}`);
    console.log(`  Total return  : ${(totalReturn * 100).toFixed(1)}%`);
    console.log(
      `  CAGR          : ${(cagr * 100).toFixed(2)}%  (${years.toFixed(1)} years held)\n`,
    );
  }
}

main();
