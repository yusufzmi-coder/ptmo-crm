import { describe, expect, it } from "vitest";

import type { IssueStatus } from "@/types";

import {
  ISSUE_STATUSES,
  INITIAL_ISSUE_STATUS,
  allowedTransitions,
  canTransition,
  isResolvedStatus,
} from "./status";

// These assert what must be TRUE of the table, not what is in it.
// Restating the map would make the test a copy that agrees with any
// edit, including a wrong one.

describe("the trail cannot be skipped", () => {
  it("refuses new -> resolved", () => {
    // The whole reason the tab exists: closing something nobody
    // acknowledged leaves no record that a human ever read it.
    expect(canTransition("new", "resolved")).toBe(false);
  });

  it("gives a brand-new issue exactly one way forward", () => {
    // Anything else is a way to skip being acknowledged.
    expect(allowedTransitions("new")).toEqual(["acknowledged"]);
  });

  it("lets nothing reach resolved except a proposed resolution", () => {
    const reachers = ISSUE_STATUSES.filter((s) => canTransition(s, "resolved"));
    expect(reachers).toEqual(["resolution_proposed"]);
  });
});

describe("resolved is not the end", () => {
  it("can be reopened", () => {
    expect(canTransition("resolved", "reopened")).toBe(true);
  });

  it("goes nowhere else", () => {
    // A resolved issue must not slide sideways into another working
    // state without the reopen being recorded.
    expect(allowedTransitions("resolved")).toEqual(["reopened"]);
  });

  it("does not send a reopened issue back through acknowledged", () => {
    // It was acknowledged once already; recording that again would
    // assert something untrue the second time.
    expect(canTransition("reopened", "acknowledged")).toBe(false);
  });

  it("puts a reopened issue back into real work", () => {
    expect(canTransition("reopened", "investigating")).toBe(true);
    expect(canTransition("reopened", "resolution_proposed")).toBe(true);
  });
});

describe("working states", () => {
  it("lets waiting and investigating cross both ways", () => {
    // A parent replies, work resumes; work stalls, we wait again.
    expect(canTransition("waiting", "investigating")).toBe(true);
    expect(canTransition("investigating", "waiting")).toBe(true);
  });

  it("lets a proposal be pulled back for more work", () => {
    expect(canTransition("resolution_proposed", "investigating")).toBe(true);
  });
});

describe("invariants that must hold for any future edit", () => {
  it("treats an unchanged status as no transition", () => {
    // The route relies on this to decide whether to write an event: a
    // PATCH that re-sends the current status must not add a row that
    // records no movement.
    for (const status of ISSUE_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("never names a status that does not exist", () => {
    for (const status of ISSUE_STATUSES) {
      for (const target of allowedTransitions(status)) {
        expect(ISSUE_STATUSES).toContain(target);
      }
    }
  });

  it("leaves no status stranded — every one is reachable from new", () => {
    // A status nothing can reach is dead config that will mislead
    // whoever reads the list later.
    const seen = new Set<IssueStatus>([INITIAL_ISSUE_STATUS]);
    const queue: IssueStatus[] = [INITIAL_ISSUE_STATUS];
    while (queue.length) {
      for (const next of allowedTransitions(queue.pop()!)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ISSUE_STATUSES].sort());
  });

  it("leaves no status without a way out", () => {
    // Every state must be escapable, or an issue parks there forever
    // with no way to close it.
    for (const status of ISSUE_STATUSES) {
      expect(allowedTransitions(status).length).toBeGreaterThan(0);
    }
  });

  it("starts at new", () => {
    expect(INITIAL_ISSUE_STATUS).toBe("new");
    // And nothing may return to it — an issue is opened once.
    const returners = ISSUE_STATUSES.filter((s) => canTransition(s, "new"));
    expect(returners).toEqual([]);
  });
});

describe("isResolvedStatus", () => {
  it("is true only for resolved", () => {
    for (const status of ISSUE_STATUSES) {
      expect(isResolvedStatus(status)).toBe(status === "resolved");
    }
    // reopened in particular must be false, or resolved_at survives a
    // reopen and every time-to-close figure derived from it is wrong.
    expect(isResolvedStatus("reopened")).toBe(false);
  });
});
