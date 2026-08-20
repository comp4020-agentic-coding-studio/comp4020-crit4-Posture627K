import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// The mechanically-checkable lines of this week's spec (crits/04-instrument).
// The experiential lines --- "expressive", "no way to play it wrong", "a
// stranger can play it uninstructed" --- are for the crit to judge, not
// something a test can assert; see spec/README.md.

const distPath = resolve("dist/index.html");
const doc = existsSync(distPath)
  ? new JSDOM(readFileSync(distPath, "utf8")).window.document
  : null;

describe("guitar orbit: built page", () => {
  it("builds an index page", () => {
    expect(doc).not.toBeNull();
  });

  it("has the exact opening copy", () => {
    const opening = doc?.querySelector('[data-testid="opening-copy"]');
    expect(opening?.textContent?.trim()).toBe(
      "Touch around the guitar to play.",
    );
  });

  it("has the orbit canvas mount point", () => {
    expect(doc?.querySelector('[data-testid="orbit-canvas"]')).toBeTruthy();
  });
});
