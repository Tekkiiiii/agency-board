// Dashboard time helpers: the zone is a parameter (IANA string from AGENCY_BOARD_TIMEZONE on the server), never hard-coded.
import { describe, expect, it } from "vitest";
import { formatDay, formatFull, relative, toDate, zoneLabel } from "../app/dashboard/_components/time";

const AT = new Date("2026-10-07T14:03:22Z");

describe("time helpers", () => {
  it("formatDay / formatFull follow the given zone", () => {
    expect(formatDay(AT, "UTC")).toBe("07 Oct 2026");
    expect(formatFull(AT, "UTC")).toBe("07 Oct 2026, 14:03:22 UTC");
    expect(formatFull(AT, "Asia/Tokyo")).toBe("07 Oct 2026, 23:03:22 GMT+9");
    expect(formatFull(AT, "America/New_York")).toBe("07 Oct 2026, 10:03:22 GMT-4");
  });

  it("a zone change can move the calendar day", () => {
    const late = new Date("2026-10-07T23:30:00Z");
    expect(formatDay(late, "UTC")).toBe("07 Oct 2026");
    expect(formatDay(late, "Pacific/Auckland")).toBe("08 Oct 2026");
  });

  it("zoneLabel uses the instant (DST aware)", () => {
    expect(zoneLabel("UTC", AT)).toBe("UTC");
    expect(zoneLabel("Europe/Berlin", new Date("2026-01-15T12:00:00Z"))).toBe("CET");
    expect(zoneLabel("Europe/Berlin", new Date("2026-07-15T12:00:00Z"))).toBe("CEST");
  });

  it("relative: just now / s / m / h / d / future / older than 30 days -> day stamp in the zone", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const ago = (s: number) => new Date(now.getTime() - s * 1000);
    expect(relative(ago(2), now)).toBe("just now");
    expect(relative(ago(12), now)).toBe("12s ago");
    expect(relative(ago(300), now)).toBe("5m ago");
    expect(relative(ago(7200), now)).toBe("2h ago");
    expect(relative(ago(3 * 86400), now)).toBe("3d ago");
    expect(relative(ago(-240), now)).toBe("in 4m");
    expect(relative(ago(40 * 86400), now, "UTC")).toBe("28 Aug 2026");
  });

  it("toDate: null-ish and invalid input -> null", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDate("not a date")).toBeNull();
    expect(toDate("2026-10-07T14:03:22Z")?.getTime()).toBe(AT.getTime());
    expect(toDate(AT)).toBe(AT);
  });
});
