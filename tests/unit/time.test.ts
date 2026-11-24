import { describe, expect, it } from "vitest";
import { addDays, hhmmToMinutes, toZonedParts, tzOffsetMinutes, weekKey, zonedToUtc } from "../../src/shared/time";

describe("time zone conversion", () => {
  it("converts Berlin winter time (UTC+1)", () => {
    expect(new Date(zonedToUtc("2026-01-15", 9 * 60, "Europe/Berlin")).toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });
  it("converts Berlin summer time (UTC+2)", () => {
    expect(new Date(zonedToUtc("2026-07-15", 9 * 60, "Europe/Berlin")).toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });
  it("handles the spring-forward gap (02:30 does not exist on 2026-03-29 in Berlin)", () => {
    const t = zonedToUtc("2026-03-29", 2 * 60 + 30, "Europe/Berlin");
    expect(new Date(t).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(toZonedParts(t, "Europe/Berlin").minuteOfDay).toBe(3 * 60 + 30);
  });
  it("chooses the earlier instant for ambiguous fall-back times", () => {
    const t = zonedToUtc("2026-10-25", 2 * 60 + 30, "Europe/Berlin");
    expect(new Date(t).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
  it("handles times right after the DST transitions", () => {
    expect(new Date(zonedToUtc("2026-03-29", 9 * 60, "Europe/Berlin")).toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(new Date(zonedToUtc("2026-10-25", 9 * 60, "Europe/Berlin")).toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });
  it("supports US zones with different DST dates", () => {
    expect(new Date(zonedToUtc("2026-03-09", 9 * 60, "America/New_York")).toISOString()).toBe("2026-03-09T13:00:00.000Z");
    expect(new Date(zonedToUtc("2026-03-07", 9 * 60, "America/New_York")).toISOString()).toBe("2026-03-07T14:00:00.000Z");
  });
  it("supports half-hour and southern hemisphere offsets", () => {
    expect(tzOffsetMinutes(Date.UTC(2026, 0, 1), "Asia/Kolkata")).toBe(330);
    expect(tzOffsetMinutes(Date.UTC(2026, 0, 1), "Australia/Sydney")).toBe(660);
    expect(tzOffsetMinutes(Date.UTC(2026, 6, 1), "Australia/Sydney")).toBe(600);
  });
  it("round-trips wall clock times", () => {
    for (const tz of ["Europe/Berlin", "America/Los_Angeles", "Asia/Tokyo", "UTC", "Pacific/Auckland"]) {
      for (const date of ["2026-01-01", "2026-03-29", "2026-06-30", "2026-10-25", "2026-11-01"]) {
        const t = zonedToUtc(date, 13 * 60 + 15, tz);
        const p = toZonedParts(t, tz);
        expect(p.date).toBe(date);
        expect(p.minuteOfDay).toBe(13 * 60 + 15);
      }
    }
  });
  it("date helpers", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekKey("2026-11-29")).toBe("2026-11-23");
    expect(weekKey("2026-11-23")).toBe("2026-11-23");
    expect(hhmmToMinutes("17:30")).toBe(1050);
    expect(() => hhmmToMinutes("25:00")).toThrow();
  });
});
