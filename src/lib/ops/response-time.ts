import type { SupabaseClient } from "@supabase/supabase-js";
import type { SenderType } from "@/types";
import {
  DEFAULT_COVERAGE,
  OPS_TIME_ZONE,
  measureWait,
  slaState,
  type CoverageWindow,
  type SlaState,
  type SlaTier,
} from "./sla";

/**
 * First Response Time — how fast we answered, on the SLA clock.
 *
 * One sample per "customer waited, we replied" pair: the FIRST inbound
 * message after our last outbound starts the clock, the next outbound
 * (agent or bot) stops it. A parent who sends three messages before we
 * answer produces one sample, measured from their first. Threads still
 * waiting produce no sample here — they are on the board instead.
 *
 * Every sample is judged by the same `measureWait` + `slaState` the
 * board uses, so "answered within target" on this card and "within
 * target" on the board mean the same thing. The headline figure is the
 * share of samples answered inside their tier's target — the number
 * the team is chasing — with the median covered wait alongside so a
 * good percentage cannot hide a long tail.
 */

export interface ResponseSampleInput {
  conversation_id: string;
  sender_type: SenderType;
  created_at: string;
}

export interface ResponseSample {
  conversationId: string;
  customerAt: string;
  repliedAt: string;
  waitedMinutes: number;
  tier: SlaTier | null;
  state: SlaState;
}

export interface ResponseTimeSummary {
  /** Samples whose reply landed inside the window. */
  answered: number;
  withinTarget: number;
  pastTarget: number;
  late: number;
  /** 0–100, null when there is nothing to measure. */
  withinTargetPct: number | null;
  /** Median covered minutes, null when there is nothing to measure. */
  medianMinutes: number | null;
  /** Slowest covered wait in the window, null when empty. */
  worstMinutes: number | null;
}

/** Pure: pair inbound runs with the reply that ended them. */
export function deriveResponseSamples(
  messages: ResponseSampleInput[],
  coverage: CoverageWindow[] = DEFAULT_COVERAGE,
  timeZone: string = OPS_TIME_ZONE,
): ResponseSample[] {
  const byConversation = new Map<string, ResponseSampleInput[]>();
  for (const m of messages) {
    const list = byConversation.get(m.conversation_id);
    if (list) list.push(m);
    else byConversation.set(m.conversation_id, [m]);
  }

  const samples: ResponseSample[] = [];
  for (const [conversationId, list] of byConversation) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    let pending: ResponseSampleInput | null = null;
    for (const m of list) {
      if (m.sender_type === "customer") {
        if (!pending) pending = m;
        continue;
      }
      if (!pending) continue;
      const wait = measureWait(
        new Date(pending.created_at),
        new Date(m.created_at),
        coverage,
        timeZone,
      );
      samples.push({
        conversationId,
        customerAt: pending.created_at,
        repliedAt: m.created_at,
        waitedMinutes: wait.minutes,
        tier: wait.tier,
        state: slaState(wait.minutes, wait.tier),
      });
      pending = null;
    }
  }
  return samples;
}

/** Pure: roll samples up into the card figures. */
export function summariseResponseTime(
  samples: ResponseSample[],
  repliedSince?: Date,
): ResponseTimeSummary {
  const inWindow = repliedSince
    ? samples.filter((s) => new Date(s.repliedAt) >= repliedSince)
    : samples;

  const answered = inWindow.length;
  const withinTarget = inWindow.filter((s) => s.state === "ok").length;
  const pastTarget = inWindow.filter((s) => s.state === "warning").length;
  const late = inWindow.filter((s) => s.state === "breached").length;

  if (answered === 0) {
    return {
      answered,
      withinTarget,
      pastTarget,
      late,
      withinTargetPct: null,
      medianMinutes: null,
      worstMinutes: null,
    };
  }

  const sorted = inWindow.map((s) => s.waitedMinutes).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    answered,
    withinTarget,
    pastTarget,
    late,
    withinTargetPct: Math.round((withinTarget / answered) * 100),
    medianMinutes: Math.round(median),
    worstMinutes: sorted[sorted.length - 1],
  };
}

/**
 * Local-day start in the operation's time zone. "Today" for a team in
 * Kuala Lumpur must not roll over at 8am because the server is in UTC.
 */
export function startOfOpsDay(now: Date, timeZone: string = OPS_TIME_ZONE): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const ymd = fmt.format(now); // YYYY-MM-DD in the ops zone
  // Find the UTC instant of local midnight by probing: local midnight
  // is within ±14h of UTC midnight of the same calendar date.
  const utcMidnight = new Date(`${ymd}T00:00:00Z`);
  for (let offsetMin = -14 * 60; offsetMin <= 14 * 60; offsetMin += 15) {
    const candidate = new Date(utcMidnight.getTime() - offsetMin * 60_000);
    if (fmt.format(candidate) === ymd) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(candidate);
      const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
      const m = Number(parts.find((p) => p.type === "minute")?.value);
      if (h === 0 && m === 0) return candidate;
    }
  }
  return utcMidnight;
}

/** Window the cards cover — a week of history, split into today + 7d. */
export const RESPONSE_LOOKBACK_DAYS = 7;

export interface ResponseTimeCards {
  today: ResponseTimeSummary;
  week: ResponseTimeSummary;
}

/** Client-side, RLS-scoped. Same query shape as the dashboard's chart. */
export async function loadResponseTimeCards(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<ResponseTimeCards> {
  // Pull a little beyond the window so a reply inside the window can
  // find the inbound message that preceded it.
  const since = new Date(now.getTime() - (RESPONSE_LOOKBACK_DAYS + 3) * 86_400_000);
  const { data, error } = await db
    .from("messages")
    .select("conversation_id, sender_type, created_at")
    .gte("created_at", since.toISOString())
    .order("conversation_id", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;

  const samples = deriveResponseSamples((data ?? []) as ResponseSampleInput[]);
  const weekStart = new Date(now.getTime() - RESPONSE_LOOKBACK_DAYS * 86_400_000);
  return {
    today: summariseResponseTime(samples, startOfOpsDay(now)),
    week: summariseResponseTime(samples, weekStart),
  };
}
