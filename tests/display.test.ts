import { describe, expect, it } from "vitest";
import { displayTaskTitle } from "../lib/display";

describe("displayTaskTitle", () => {
  it("strips ids from real agent-written titles", () => {
    expect(displayTaskTitle("DEDUPE: dcd87071 and dde11961 are the same headless redo - do it once")).toBe(
      "DEDUPE: the same headless redo - do it once",
    );
    expect(displayTaskTitle("REDO 605ec194: character sheet body row")).toBe("REDO: character sheet body row");
    expect(displayTaskTitle("REJECTED dcd87071/dde11961: headless figures mis-composited")).toBe(
      "REJECTED: headless figures mis-composited",
    );
    expect(displayTaskTitle("READ FIRST: addendum to 23f7278e image fixes")).toBe("READ FIRST: addendum to image fixes");
  });

  it("strips full UUIDs, task prefixes, upper case, comma lists and empty brackets", () => {
    expect(displayTaskTitle("Fix 3f2b8c1e-9a4d-4e7b-8c21-0123456789ab now")).toBe("Fix now");
    expect(displayTaskTitle("Review task DCD87071, DDE11961: logos")).toBe("Review: logos");
    expect(displayTaskTitle("Ship [dcd87071] landing page")).toBe("Ship landing page");
    expect(displayTaskTitle("Retry #605ec194 (dcd87071)")).toBe("Retry");
  });

  it("leaves titles without ids untouched", () => {
    expect(displayTaskTitle("Ship the landing page")).toBe("Ship the landing page");
    expect(displayTaskTitle("Fix: header spacing (mobile)")).toBe("Fix: header spacing (mobile)");
  });

  it("does not touch colors, plain hex words or 8-digit numbers", () => {
    expect(displayTaskTitle("Use #F5A623 for the accent")).toBe("Use #F5A623 for the accent");
    expect(displayTaskTitle("Use deadbeef as the sentinel")).toBe("Use deadbeef as the sentinel");
    expect(displayTaskTitle("A facade for the build")).toBe("A facade for the build");
    expect(displayTaskTitle("Report for 20261008 batch")).toBe("Report for 20261008 batch");
  });

  it("returns the original title when stripping would leave nothing", () => {
    expect(displayTaskTitle("dcd87071")).toBe("dcd87071");
    expect(displayTaskTitle("dcd87071 / dde11961")).toBe("dcd87071 / dde11961");
  });
});
