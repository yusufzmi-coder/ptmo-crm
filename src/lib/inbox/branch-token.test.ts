import { describe, expect, it } from "vitest";
import {
  expandBranchTokens,
  findForeignBranchMentions,
  hasBranchToken,
} from "./branch-token";

const BRANCHES = ["Batu Caves", "Rawang", "Gombak", "Kota Damansara", "PJ"];

describe("hasBranchToken", () => {
  it("finds the Malay token", () => {
    expect(hasBranchToken("Sila datang ke {{cawangan}}")).toBe(true);
  });

  it("finds the English alias", () => {
    expect(hasBranchToken("Please visit {{branch}}")).toBe(true);
  });

  it("tolerates padding and case", () => {
    expect(hasBranchToken("ke {{ Cawangan }} sebelum 6")).toBe(true);
  });

  it("is false for plain text", () => {
    expect(hasBranchToken("Sila datang ke Rawang")).toBe(false);
  });

  it("is false for nullish input", () => {
    expect(hasBranchToken(null)).toBe(false);
    expect(hasBranchToken(undefined)).toBe(false);
    expect(hasBranchToken("")).toBe(false);
  });

  // The /g regex carries `lastIndex` between calls. Without a reset this
  // alternates true/false on identical input, which would make a
  // snippet's warning appear only every other time the picker opened.
  it("returns the same answer when called repeatedly", () => {
    const text = "ke {{cawangan}} ya";
    expect(hasBranchToken(text)).toBe(true);
    expect(hasBranchToken(text)).toBe(true);
    expect(hasBranchToken(text)).toBe(true);
  });
});

describe("expandBranchTokens", () => {
  it("replaces the token with the branch name", () => {
    expect(
      expandBranchTokens("Sila datang ke {{cawangan}} sebelum 6 petang.", "Rawang"),
    ).toBe("Sila datang ke Rawang sebelum 6 petang.");
  });

  it("replaces every occurrence, mixed spellings and cases", () => {
    expect(
      expandBranchTokens(
        "{{cawangan}} buka pukul 9. Alamat {{ BRANCH }} ada di bawah. — {{Cawangan}}",
        "Batu Caves",
      ),
    ).toBe(
      "Batu Caves buka pukul 9. Alamat Batu Caves ada di bawah. — Batu Caves",
    );
  });

  it("leaves text without tokens untouched", () => {
    expect(expandBranchTokens("Terima kasih!", "Gombak")).toBe("Terima kasih!");
  });

  // A blank branch would turn "ke {{cawangan}} sebelum 6" into
  // "ke  sebelum 6" and send it to a parent. Refusing loudly is the
  // whole point — the caller is supposed to have blocked the snippet.
  it("throws rather than expanding to nothing", () => {
    expect(() => expandBranchTokens("ke {{cawangan}}", "")).toThrow();
    expect(() => expandBranchTokens("ke {{cawangan}}", "   ")).toThrow();
  });
});

describe("findForeignBranchMentions", () => {
  it("flags another branch named in the text", () => {
    expect(
      findForeignBranchMentions(
        "Sila datang ke cawangan Batu Caves sebelum 6 petang.",
        "Rawang",
        BRANCHES,
      ),
    ).toEqual(["Batu Caves"]);
  });

  it("does not flag the thread's own branch", () => {
    expect(
      findForeignBranchMentions(
        "Sila datang ke cawangan Rawang sebelum 6 petang.",
        "Rawang",
        BRANCHES,
      ),
    ).toEqual([]);
  });

  it("matches case-insensitively", () => {
    expect(
      findForeignBranchMentions("jumpa di GOMBAK ya", "Rawang", BRANCHES),
    ).toEqual(["Gombak"]);
  });

  it("reports several foreign branches once each", () => {
    expect(
      findForeignBranchMentions(
        "Kelas ganti di Gombak atau Batu Caves. Gombak penuh.",
        "Rawang",
        BRANCHES,
      ),
    ).toEqual(["Batu Caves", "Gombak"]);
  });

  it("flags nothing in a tokenised snippet", () => {
    expect(
      findForeignBranchMentions(
        "Sila datang ke {{cawangan}} sebelum 6 petang.",
        "Rawang",
        BRANCHES,
      ),
    ).toEqual([]);
  });

  // "Rawang" must not match inside "Rawangan", or a snippet would be
  // flagged for a word that merely starts the same way.
  it("does not match a label glued inside a longer word", () => {
    expect(
      findForeignBranchMentions("Kawasan Rawangan itu jauh", "Gombak", [
        "Rawang",
      ]),
    ).toEqual([]);
  });

  it("does not match a label glued to a digit", () => {
    expect(
      findForeignBranchMentions("Kelas di Rawang2 penuh", "Gombak", ["Rawang"]),
    ).toEqual([]);
  });

  it("matches a label next to punctuation", () => {
    expect(
      findForeignBranchMentions("Cawangan: Gombak, pukul 9.", "Rawang", BRANCHES),
    ).toEqual(["Gombak"]);
  });

  // Two-letter labels collide with ordinary words; a warning that cries
  // wolf gets dismissed, taking the real ones with it.
  it("ignores labels shorter than three characters", () => {
    expect(
      findForeignBranchMentions("Jumpa di PJ nanti", "Rawang", BRANCHES),
    ).toEqual([]);
  });

  // Current branch "Rawang 2": a search for "Rawang" would match the
  // thread's own name and read as a bug to the agent.
  it("skips a label that is a substring of the current branch", () => {
    expect(
      findForeignBranchMentions("Sila ke Rawang 2 esok", "Rawang 2", [
        "Rawang",
        "Rawang 2",
      ]),
    ).toEqual([]);
  });

  it("still flags a longer label containing the current one", () => {
    expect(
      findForeignBranchMentions("Sila ke Rawang 2 esok", "Rawang", [
        "Rawang",
        "Rawang 2",
      ]),
    ).toEqual(["Rawang 2"]);
  });

  it("flags everything when the thread has no branch", () => {
    expect(
      findForeignBranchMentions("Sila ke Gombak", null, BRANCHES),
    ).toEqual(["Gombak"]);
  });

  it("is empty for nullish text", () => {
    expect(findForeignBranchMentions(null, "Rawang", BRANCHES)).toEqual([]);
    expect(findForeignBranchMentions("", "Rawang", BRANCHES)).toEqual([]);
  });

  it("treats a label with regex metacharacters literally", () => {
    expect(
      findForeignBranchMentions("Jumpa di C++ Centre ok", "Rawang", ["C++ Centre"]),
    ).toEqual(["C++ Centre"]);
  });
});
