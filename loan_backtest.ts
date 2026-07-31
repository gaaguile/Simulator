/**
 * Rolling 12-month comparison: borrow $20,000 at 10% APR (12 equal monthly
 * amortizing installments), lump-sum the full amount into IYW on day one —
 * versus DCA-ing the same $20,000 in 12 equal monthly contributions with no
 * debt. Evaluated at every possible 12-month start month since 2010, so you
 * can see the full distribution of outcomes rather than one cherry-picked
 * window.
 *
 * Fairness of the comparison: both scenarios are compared on the SAME
 * yardstick — the money-weighted annualized return (XIRR) of what actually
 * leaves the investor's own pocket each month:
 *   - Loan scenario: 12 monthly loan installments (principal + interest)
 *     paid out of pocket; the $20k hits the brokerage account immediately
 *     via the loan, fully invested from day 1.
 *   - DCA scenario: 12 monthly contributions of $20k/12 paid out of pocket;
 *     no debt, exposure ramps up gradually over the year.
 * Both are evaluated for terminal value exactly at the 12-month mark (loan
 * payoff date), since that's the natural point to judge "was borrowing worth
 * it" for a strategy scoped to a single loan term.
 *
 * Run locally (Node 18+):
 *   npm install -D typescript tsx @types/node
 *   npx tsx loan-vs-dca-backtest.ts
 */

const TICKER = "IYW";
const PRINCIPAL = 20000;
const APR = 0.1;
const LOAN_MONTHS = 12;
const FETCH_FROM = "2009-11-01";
const REPORT_FROM = "2010-01-01";

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
  for (const bars of months.values()) {
    bars.sort((a, b) => a.date.getTime() - b.date.getTime());
    monthly.push({
      date: bars[bars.length - 1].date,
      close: bars[bars.length - 1].close,
    });
  }
  return monthly.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// Standard amortizing loan payment.
function monthlyInstallment(
  principal: number,
  apr: number,
  months: number,
): number {
  const r = apr / 12;
  return (
    (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1)
  );
}

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

interface WindowResult {
  startDate: Date;
  endDate: Date;
  loanFinalValue: number;
  loanXirr: number;
  dcaFinalValue: number;
  dcaXirr: number;
  edgeXirr: number; // loanXirr - dcaXirr
}

function runWindow(monthly: MonthlyBar[], startIdx: number): WindowResult {
  const installment = monthlyInstallment(PRINCIPAL, APR, LOAN_MONTHS);
  const monthlyContribution = PRINCIPAL / LOAN_MONTHS;

  const entryBar = monthly[startIdx];
  const endBar = monthly[startIdx + LOAN_MONTHS];

  // --- Loan scenario: full lump sum on day 0, financed by 12 installments ---
  const unitsLoan = PRINCIPAL / entryBar.close;
  const loanCashflows: { date: Date; amount: number }[] = [];
  for (let m = 1; m <= LOAN_MONTHS; m++) {
    loanCashflows.push({
      date: monthly[startIdx + m].date,
      amount: -installment,
    });
  }
  const loanFinalValue = unitsLoan * endBar.close;
  loanCashflows.push({ date: endBar.date, amount: loanFinalValue });
  const loanXirr = xirr(loanCashflows);

  // --- DCA scenario: 12 equal monthly buys, no debt ---
  let unitsDca = 0;
  const dcaCashflows: { date: Date; amount: number }[] = [];
  for (let m = 0; m < LOAN_MONTHS; m++) {
    const bar = monthly[startIdx + m];
    unitsDca += monthlyContribution / bar.close;
    dcaCashflows.push({ date: bar.date, amount: -monthlyContribution });
  }
  const dcaFinalValue = unitsDca * endBar.close;
  dcaCashflows.push({ date: endBar.date, amount: dcaFinalValue });
  const dcaXirr = xirr(dcaCashflows);

  return {
    startDate: entryBar.date,
    endDate: endBar.date,
    loanFinalValue,
    loanXirr,
    dcaFinalValue,
    dcaXirr,
    edgeXirr: loanXirr - dcaXirr,
  };
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const daily = await fetchDailyAdjusted(TICKER);
  const monthly = toMonthly(daily);

  const firstReportIdx = monthly.findIndex(
    (b) => b.date >= new Date(REPORT_FROM),
  );
  const lastPossibleStart = monthly.length - 1 - LOAN_MONTHS;

  const installment = monthlyInstallment(PRINCIPAL, APR, LOAN_MONTHS);
  const totalPaidLoan = installment * LOAN_MONTHS;
  console.log(
    `${TICKER}: rolling 12-month windows, loan (10% APR, 12 installments, lump sum) vs DCA ($${PRINCIPAL.toLocaleString()})`,
  );
  console.log(
    `Loan installment: ${fmtUsd(installment)}/month  |  Total repaid: ${fmtUsd(totalPaidLoan)}  (effective cost: ${((totalPaidLoan / PRINCIPAL - 1) * 100).toFixed(2)}% of principal)\n`,
  );

  const results: WindowResult[] = [];
  for (let i = firstReportIdx; i <= lastPossibleStart; i++) {
    results.push(runWindow(monthly, i));
  }

  const loanWins = results.filter((r) => r.edgeXirr > 0).length;
  const winRate = (loanWins / results.length) * 100;
  const avgEdge = results.reduce((s, r) => s + r.edgeXirr, 0) / results.length;
  const avgLoanXirr =
    results.reduce((s, r) => s + r.loanXirr, 0) / results.length;
  const avgDcaXirr =
    results.reduce((s, r) => s + r.dcaXirr, 0) / results.length;

  console.log(
    `Total rolling windows tested: ${results.length}  (${fmtDate(results[0].startDate)} start -> ${fmtDate(results[results.length - 1].startDate)} start)\n`,
  );
  console.log(
    `Loan-funded lump sum beat DCA in ${loanWins}/${results.length} windows (${winRate.toFixed(1)}%)`,
  );
  console.log(`Average XIRR — loan strategy : ${fmtPct(avgLoanXirr)}`);
  console.log(`Average XIRR — DCA strategy  : ${fmtPct(avgDcaXirr)}`);
  console.log(`Average edge (loan - DCA)    : ${fmtPct(avgEdge)}\n`);

  const byEdge = [...results].sort((a, b) => a.edgeXirr - b.edgeXirr);
  console.log(`--- 5 worst windows for the loan strategy (vs DCA) ---`);
  for (const r of byEdge.slice(0, 5)) {
    console.log(
      `  ${fmtDate(r.startDate)} -> ${fmtDate(r.endDate)}  loan=${fmtPct(r.loanXirr)}  dca=${fmtPct(r.dcaXirr)}  edge=${fmtPct(r.edgeXirr)}  (loan final: ${fmtUsd(r.loanFinalValue)}, dca final: ${fmtUsd(r.dcaFinalValue)})`,
    );
  }

  console.log(`\n--- 5 best windows for the loan strategy (vs DCA) ---`);
  for (const r of byEdge.slice(-5).reverse()) {
    console.log(
      `  ${fmtDate(r.startDate)} -> ${fmtDate(r.endDate)}  loan=${fmtPct(r.loanXirr)}  dca=${fmtPct(r.dcaXirr)}  edge=${fmtPct(r.edgeXirr)}  (loan final: ${fmtUsd(r.loanFinalValue)}, dca final: ${fmtUsd(r.dcaFinalValue)})`,
    );
  }

  const worstLoanOutcome = [...results].sort(
    (a, b) => a.loanXirr - b.loanXirr,
  )[0];
  console.log(`\n--- Worst absolute outcome for the loan strategy itself ---`);
  console.log(
    `  ${fmtDate(worstLoanOutcome.startDate)} -> ${fmtDate(worstLoanOutcome.endDate)}  loan XIRR=${fmtPct(worstLoanOutcome.loanXirr)}  (final value ${fmtUsd(worstLoanOutcome.loanFinalValue)} vs ${fmtUsd(totalPaidLoan)} repaid)`,
  );
}

main();
