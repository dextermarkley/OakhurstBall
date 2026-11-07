// Payment plans and club periods.
//
// The club year starts April 1. Quarters:
//   Q1 Apr 1 – Jun 30 · Q2 Jul 1 – Sep 30 · Q3 Oct 1 – Dec 31 · Q4 Jan 1 – Mar 31
// A club year is named by the calendar year it starts in: year 2026 = Apr 1 2026 –
// Mar 31 2027 ("2026–27"). Dates are club-local (CLUB_TZ), so a period ends at
// local midnight. A pass covers the period it was bought in; no proration.

export type Plan = 'quarter' | 'year';

const cents = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : dflt;
};

export const PLAN_PRICES: Record<Plan, number> = {
  quarter: cents('QUARTER_PASS_CENTS', 8000),
  year: cents('YEAR_PASS_CENTS', 32000),
};

export interface Period {
  plan: Plan;
  /** Stable key: "Y2026" or "Q2026-1". */
  periodId: string;
  label: string; // "Q1 2026–27 (Apr 1 – Jun 30)" / "2026–27 season"
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDate(d: string): { y: number; m: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`bad date ${d}`);
  return { y: Number(m[1]), m: Number(m[2]) };
}

/** Club year (the calendar year it starts in) for a club-local date. */
export function clubYear(date: string): number {
  const { y, m } = parseDate(date);
  return m >= 4 ? y : y - 1;
}

/** Quarter number 1-4 within the club year. */
export function clubQuarter(date: string): 1 | 2 | 3 | 4 {
  const { m } = parseDate(date);
  return (Math.floor(((m - 4 + 12) % 12) / 3) + 1) as 1 | 2 | 3 | 4;
}

const yearName = (cy: number) => `${cy}–${String((cy + 1) % 100).padStart(2, '0')}`;

export function periodFor(plan: Plan, date: string): Period {
  const cy = clubYear(date);
  if (plan === 'year') {
    return {
      plan,
      periodId: `Y${cy}`,
      label: `${yearName(cy)} season`,
      start: `${cy}-04-01`,
      end: `${cy + 1}-03-31`,
    };
  }
  const q = clubQuarter(date);
  const startMonth = ((q - 1) * 3 + 3) % 12 + 1; // 4, 7, 10, 1
  const endMonth = startMonth + 2; // 6, 9, 12, 3
  const y = q === 4 ? cy + 1 : cy; // Q4 falls in the next calendar year
  return {
    plan,
    periodId: `Q${cy}-${q}`,
    label: `Q${q} ${yearName(cy)} (${MONTHS[startMonth - 1]} 1 – ${MONTHS[endMonth - 1]} ${lastDay(y, endMonth)})`,
    start: `${y}-${pad(startMonth)}-01`,
    end: `${y}-${pad(endMonth)}-${pad(lastDay(y, endMonth))}`,
  };
}

export const isPlan = (p: unknown): p is Plan => p === 'quarter' || p === 'year';
