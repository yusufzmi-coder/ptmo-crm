import { describe, expect, it } from "vitest";
import {
  decorateQuickReplyForBranch,
  type StoredQuickReply,
} from "./quick-reply-branch";

const BRANCHES = ["Batu Caves", "Rawang", "Gombak", "Kota Damansara"];

const text = (content_text: string | null): StoredQuickReply => ({
  id: "q1",
  title: "Snippet",
  kind: "text",
  content_text,
});

/** A valid reply-buttons payload, per src/lib/whatsapp/interactive.ts. */
const buttons = (bodyText: string, buttonTitle: string): StoredQuickReply => ({
  id: "q2",
  title: "Snippet",
  kind: "interactive",
  content_text: null,
  interactive_payload: {
    kind: "buttons",
    body: bodyText,
    buttons: [{ id: "b1", title: buttonTitle }],
  },
});

describe("decorateQuickReplyForBranch", () => {
  it("expands the token to the thread's branch", () => {
    const out = decorateQuickReplyForBranch(
      text("Sila datang ke {{cawangan}} sebelum 6 petang."),
      "Rawang",
      BRANCHES,
    );
    expect(out.content_text).toBe("Sila datang ke Rawang sebelum 6 petang.");
    expect(out.branch_unresolved).toBe(false);
    expect(out.foreign_branches).toEqual([]);
  });

  it("leaves untokenised text alone", () => {
    const out = decorateQuickReplyForBranch(
      text("Terima kasih!"),
      "Rawang",
      BRANCHES,
    );
    expect(out.content_text).toBe("Terima kasih!");
    expect(out.branch_unresolved).toBe(false);
  });

  // The whole point of the feature: one snippet, sixteen centres, and
  // the wrong name becomes impossible rather than merely discouraged.
  it("gives two branches two different texts from one snippet", () => {
    const snippet = text("Kelas di {{cawangan}} bermula 8:30 pagi.");
    expect(
      decorateQuickReplyForBranch(snippet, "Rawang", BRANCHES).content_text,
    ).toBe("Kelas di Rawang bermula 8:30 pagi.");
    expect(
      decorateQuickReplyForBranch(snippet, "Gombak", BRANCHES).content_text,
    ).toBe("Kelas di Gombak bermula 8:30 pagi.");
  });

  it("blocks a tokenised snippet when the thread has no branch", () => {
    const out = decorateQuickReplyForBranch(
      text("Sila datang ke {{cawangan}}."),
      null,
      BRANCHES,
    );
    expect(out.branch_unresolved).toBe(true);
    // Left exactly as stored — never blanked, never half-expanded.
    expect(out.content_text).toBe("Sila datang ke {{cawangan}}.");
  });

  it("does not block an untokenised snippet on a branchless thread", () => {
    const out = decorateQuickReplyForBranch(
      text("Terima kasih!"),
      null,
      BRANCHES,
    );
    expect(out.branch_unresolved).toBe(false);
  });

  it("flags a snippet that hardcodes another centre", () => {
    const out = decorateQuickReplyForBranch(
      text("Sila datang ke cawangan Batu Caves sebelum 6 petang."),
      "Rawang",
      BRANCHES,
    );
    expect(out.foreign_branches).toEqual(["Batu Caves"]);
    // Flagged, not blocked — the wording may well be deliberate.
    expect(out.branch_unresolved).toBe(false);
  });

  it("does not flag the thread's own centre", () => {
    const out = decorateQuickReplyForBranch(
      text("Sila datang ke cawangan Rawang."),
      "Rawang",
      BRANCHES,
    );
    expect(out.foreign_branches).toEqual([]);
  });

  it("flags nothing on a single-number account", () => {
    // The route passes an empty vocabulary when only one number is
    // connected: there is no other centre to name by mistake.
    const out = decorateQuickReplyForBranch(
      text("Sila datang ke cawangan Batu Caves."),
      "Batu Caves",
      [],
    );
    expect(out.foreign_branches).toEqual([]);
  });

  it("handles a null content_text without throwing", () => {
    const out = decorateQuickReplyForBranch(text(null), "Rawang", BRANCHES);
    expect(out.content_text).toBeNull();
    expect(out.foreign_branches).toEqual([]);
  });

  describe("interactive snippets", () => {
    it("expands tokens inside the payload", () => {
      const out = decorateQuickReplyForBranch(
        buttons("Kelas di {{cawangan}}?", "Ya"),
        "Rawang",
        BRANCHES,
      );
      expect(out.branch_unresolved).toBe(false);
      expect(out.interactive_payload).toMatchObject({
        body: "Kelas di Rawang?",
      });
    });

    it("blocks the snippet when expansion breaks Meta's limits", () => {
      // Meta caps a button title at 20 characters. "Ke {{cawangan}}" is
      // 15 as stored, so it saved cleanly — but a long centre name
      // pushes the expanded title to 23, and Meta would reject the send
      // after the agent had already clicked. Refuse it in the picker.
      const stored = buttons("Pilih", "Ke {{cawangan}}");
      const longBranch = "Kota Damansara Utara";

      // Valid as stored, on a short branch...
      expect(
        decorateQuickReplyForBranch(stored, "Rawang", BRANCHES)
          .branch_unresolved,
      ).toBe(false);

      // ...and refused on the long one.
      const out = decorateQuickReplyForBranch(stored, longBranch, BRANCHES);
      expect(out.branch_unresolved).toBe(true);
      expect(out.branch_expand_error).toBeTruthy();
    });

    it("flags a foreign centre named inside the payload", () => {
      const out = decorateQuickReplyForBranch(
        buttons("Kelas ganti di Gombak?", "Ya"),
        "Rawang",
        BRANCHES,
      );
      expect(out.foreign_branches).toEqual(["Gombak"]);
    });

    it("blocks a tokenised payload on a branchless thread", () => {
      const out = decorateQuickReplyForBranch(
        buttons("Kelas di {{cawangan}}?", "Ya"),
        null,
        BRANCHES,
      );
      expect(out.branch_unresolved).toBe(true);
    });
  });
});
