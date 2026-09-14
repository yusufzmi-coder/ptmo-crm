import { describe, it, expect } from "vitest";
import {
  ASSIGNMENT_FILTERS,
  assigneeBadge,
  assignmentLabelKey,
  matchesAssignment,
  type AssignmentFilter,
} from "./assignment";

const ME = "user-me";
const THEM = "user-them";

function conv(assigned_agent_id?: string) {
  return { assigned_agent_id };
}

describe("matchesAssignment", () => {
  it("'all' matches every thread regardless of owner", () => {
    expect(matchesAssignment(conv(), "all", ME)).toBe(true);
    expect(matchesAssignment(conv(ME), "all", ME)).toBe(true);
    expect(matchesAssignment(conv(THEM), "all", ME)).toBe(true);
  });

  it("'mine' matches only threads assigned to the current user", () => {
    expect(matchesAssignment(conv(ME), "mine", ME)).toBe(true);
    expect(matchesAssignment(conv(THEM), "mine", ME)).toBe(false);
    expect(matchesAssignment(conv(), "mine", ME)).toBe(false);
  });

  it("'unassigned' matches only threads nobody owns", () => {
    expect(matchesAssignment(conv(), "unassigned", ME)).toBe(true);
    expect(matchesAssignment(conv(ME), "unassigned", ME)).toBe(false);
    expect(matchesAssignment(conv(THEM), "unassigned", ME)).toBe(false);
  });

  it("'others' matches owned threads that are not the current user's", () => {
    expect(matchesAssignment(conv(THEM), "others", ME)).toBe(true);
    expect(matchesAssignment(conv(ME), "others", ME)).toBe(false);
    // Unowned is NOT "others" — that is what the Unassigned filter is for.
    expect(matchesAssignment(conv(), "others", ME)).toBe(false);
  });

  it("treats an explicitly undefined assignee the same as an absent one", () => {
    expect(matchesAssignment({ assigned_agent_id: undefined }, "unassigned", ME)).toBe(
      true,
    );
  });

  describe("while auth is still resolving (currentUserId null)", () => {
    it("matches nothing for the identity-relative filters", () => {
      // Guessing here is worse than showing nothing: a false "mine"
      // invites an agent onto a thread they do not own.
      expect(matchesAssignment(conv(ME), "mine", null)).toBe(false);
      expect(matchesAssignment(conv(THEM), "others", null)).toBe(false);
    });

    it("still works for the filters that do not depend on identity", () => {
      expect(matchesAssignment(conv(), "unassigned", null)).toBe(true);
      expect(matchesAssignment(conv(THEM), "all", null)).toBe(true);
    });
  });

  it("partitions any thread into exactly one of mine/unassigned/others", () => {
    // The three non-"all" filters must tile the space — no thread may
    // fall through all of them, or it becomes unreachable in the UI.
    for (const c of [conv(), conv(ME), conv(THEM)]) {
      const hits = (["mine", "unassigned", "others"] as AssignmentFilter[]).filter(
        (f) => matchesAssignment(c, f, ME),
      );
      expect(hits).toHaveLength(1);
    }
  });
});

describe("assignmentLabelKey", () => {
  it("gives every filter a distinct key", () => {
    const keys = ASSIGNMENT_FILTERS.map(assignmentLabelKey);
    expect(new Set(keys).size).toBe(ASSIGNMENT_FILTERS.length);
  });
});

describe("assigneeBadge", () => {
  const names: Record<string, string> = { [ME]: "Yusuf Azmi", [THEM]: "Aina" };
  const nameFor = (id: string) => names[id] ?? null;

  it("returns null for an unowned thread, so the row shows no chip", () => {
    expect(assigneeBadge(conv(), ME, nameFor)).toBeNull();
  });

  it("marks the current user's own threads", () => {
    expect(assigneeBadge(conv(ME), ME, nameFor)).toEqual({
      initial: "Y",
      isMine: true,
      name: "Yusuf Azmi",
    });
  });

  it("marks a teammate's thread as not mine", () => {
    expect(assigneeBadge(conv(THEM), ME, nameFor)).toEqual({
      initial: "A",
      isMine: false,
      name: "Aina",
    });
  });

  it("still shows a chip when the owner's name has not loaded", () => {
    // The thread IS owned; that fact matters more than knowing by whom.
    expect(assigneeBadge(conv("user-unknown"), ME, () => null)).toEqual({
      initial: "?",
      isMine: false,
      name: null,
    });
  });

  it("falls back to '?' rather than an empty chip for a blank name", () => {
    expect(assigneeBadge(conv(THEM), ME, () => "   ")?.initial).toBe("?");
  });

  it("is not mine while auth is still resolving", () => {
    expect(assigneeBadge(conv(ME), null, nameFor)?.isMine).toBe(false);
  });
});
