/**
 * Currency — single source of truth for deal-value formatting and
 * the currency picker options.
 *
 * Before this module, ~6 components each defined their own
 * `Intl.NumberFormat(..., { currency: "USD" })` helper with USD
 * baked in. The default currency is now configurable per account
 * (accounts.default_currency, migration 021), so every formatter
 * takes a currency and falls back to DEFAULT_CURRENCY only when
 * nothing is known.
 */

/** App-wide fallback when no account/deal currency is available. */
export const DEFAULT_CURRENCY = "MYR";

export interface CurrencyOption {
  /** ISO-4217 code, e.g. "USD". Stored verbatim in the DB. */
  code: string;
  /** Human label for the dropdown, e.g. "US Dollar". */
  label: string;
  /** Symbol for compact display, e.g. "$". */
  symbol: string;
  /**
   * Optional BCP-47 locale used when formatting this currency.
   *
   * `Intl.NumberFormat` picks the symbol from the *locale*, not the
   * currency: an en-US runtime renders MYR as "MYR 1,234" rather than
   * the "RM 1,234" a Malaysian user expects, because en-US has no
   * short form for that code. Pinning a locale on the currency fixes
   * the display wherever the browser happens to be set.
   *
   * Leave undefined to keep the previous behaviour — format in the
   * runtime's own locale.
   */
  locale?: string;
}

/**
 * The currencies offered in pickers. Codes must be valid ISO-4217 so
 * `Intl.NumberFormat` renders the right symbol/grouping. Extend this
 * list to offer more — nothing else needs to change.
 */
export const CURRENCIES: CurrencyOption[] = [
  // PTMO trades in ringgit and nothing else, so this list is deliberately
  // one entry long rather than a long menu with one correct answer in it.
  // ms-MY so the symbol resolves to "RM" regardless of browser locale.
  { code: "MYR", label: "Malaysian Ringgit", symbol: "RM", locale: "ms-MY" },
];

/**
 * Format a deal value as a currency string. Whole-number output
 * (no minor units) — deal values are tracked to the dollar across
 * the app. `currency` defaults to MYR so callers with nothing better
 * stay safe, but pass the account/deal currency wherever known.
 *
 * When the code carries a `locale` in CURRENCIES that locale is used,
 * so its symbol renders the way its own market writes it.
 *
 * Total by design: `Intl.NumberFormat` throws a RangeError on a
 * structurally invalid currency code, and `deals.currency` carries
 * NO DB CHECK (only `accounts.default_currency` does), so legacy
 * rows, imports, or hand-edited data can hold malformed values like
 * "United States". We never let that crash a render — on a bad code
 * we fall back to "CODE 1,234".
 */
export function formatCurrency(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = (currency || DEFAULT_CURRENCY).trim();
  const amount = Number(value) || 0;
  // A currency may pin its own locale (see CurrencyOption.locale).
  // Anything without one keeps formatting in the runtime locale.
  const locale = CURRENCIES.find((c) => c.code === code)?.locale;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // Invalid ISO code — show the raw code + grouped number so the
    // value is still legible instead of throwing.
    return `${code} ${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(amount)}`;
  }
}

/**
 * Compact currency for tight spaces (donut center, legend rows):
 * "$1.2M" / "€34.5k" / "₹900". Uses the currency's symbol from
 * CURRENCIES, falling back to the code when we don't carry a symbol.
 */
export function formatCurrencyShort(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = currency || DEFAULT_CURRENCY;
  const symbol = CURRENCIES.find((c) => c.code === code)?.symbol ?? `${code} `;
  return `${symbol}${formatCompactNumber(value)}`;
}

/**
 * Compact number for tight spaces (chart tiles, legends): 1_234 → "1.2k",
 * 1_200_000 → "1.2M", 900 → "900". The unit-less core shared with
 * {@link formatCurrencyShort}.
 */
export function formatCompactNumber(value: number): string {
  const v = Number(value || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}
