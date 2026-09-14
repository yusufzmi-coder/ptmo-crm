import { describe, it, expect } from "vitest";
import { suggestCentreId } from "@/components/inbox/open-case-dialog";
import type { Centre, Contact, Tag } from "@/types";

const centres = [
  { id: "c-ampang", name: "Ampang" },
  { id: "c-rawang", name: "Rawang" },
  { id: "c-rawang-2", name: "Rawang 2" },
] as Pick<Centre, "id" | "name">[];

function contactWith(...names: string[]): Pick<Contact, "tags"> {
  return { tags: names.map((name, i) => ({ id: `t${i}`, name }) as Tag) };
}

describe("suggestCentreId", () => {
  it("matches a tag to the centre with the same name", () => {
    expect(suggestCentreId(contactWith("Ampang"), centres)).toBe("c-ampang");
  });

  it("ignores case and surrounding space on both sides", () => {
    expect(suggestCentreId(contactWith("  ampang "), centres)).toBe("c-ampang");
  });

  it("returns null when no tag names a centre", () => {
    // The caller leaves the field empty rather than guessing. A case
    // with no centre is better than a case filed against the wrong one.
    expect(suggestCentreId(contactWith("VIP", "Follow-up"), centres)).toBeNull();
  });

  it("returns null for a contact with no tags at all", () => {
    expect(suggestCentreId(contactWith(), centres)).toBeNull();
    expect(suggestCentreId({ tags: undefined }, centres)).toBeNull();
    expect(suggestCentreId(null, centres)).toBeNull();
  });

  it("returns null when there are no centres to match against", () => {
    expect(suggestCentreId(contactWith("Ampang"), [])).toBeNull();
  });

  it("does not let 'Rawang' claim 'Rawang 2'", () => {
    // Whole-name equality, not prefix. A contact tagged for one branch
    // must not pre-select its neighbour — branch-token.ts carries the
    // same rule for the same pair of real centre names.
    expect(suggestCentreId(contactWith("Rawang"), centres)).toBe("c-rawang");
    expect(suggestCentreId(contactWith("Rawang 2"), centres)).toBe("c-rawang-2");
  });

  it("picks by centre order when a contact carries two centre tags", () => {
    // Ambiguous input, so the answer is arbitrary — but it must be
    // STABLE, or the same contact would pre-select a different branch on
    // each render. Centre order decides, and centres load sorted by name.
    const both = contactWith("Rawang", "Ampang");
    expect(suggestCentreId(both, centres)).toBe("c-ampang");
    expect(suggestCentreId(both, centres)).toBe("c-ampang");
  });
});
