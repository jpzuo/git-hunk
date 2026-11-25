// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compileFindRegex, findMatchesInLine } from "../inFileSearch";

describe("inFileSearch", () => {
  it("supports case-insensitive, whole-word, and regex searches safely", () => {
    const plain = compileFindRegex({
      query: "foo",
      caseSensitive: false,
      wholeWord: true,
      useRegex: false,
    });
    expect(plain.error).toBeNull();
    expect(findMatchesInLine("foo foobar FOO _foo", plain.regex)).toEqual([
      { start: 0, end: 3 },
      { start: 11, end: 14 },
    ]);

    const bad = compileFindRegex({
      query: "(unclosed",
      caseSensitive: false,
      wholeWord: false,
      useRegex: true,
    });
    expect(bad.regex).toBeNull();
    expect(bad.error).toBeTruthy();
  });
});
