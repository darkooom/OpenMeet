import { describe, expect, it } from "vitest";
import { buildIcs, parseIcsBusy } from "../../src/server/services/ics";
import { evaluateRouting } from "../../src/server/services/routing";
import { splitStatements } from "../../src/database/migrate";
import { interpolate } from "../../src/server/services/workflows";

describe("ICS", () => {
  it("builds valid, folded and escaped calendar files", () => {
    const ics = buildIcs([{ uid: "b1@openmeet", start: Date.UTC(2026, 11, 7, 9), end: Date.UTC(2026, 11, 7, 9, 30), summary: "Intro; call, with comma", description: "x".repeat(200) }], { method: "REQUEST" });
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("DTSTART:20261207T090000Z");
    expect(ics).toContain("SUMMARY:Intro\\; call\\, with comma");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
  it("parses busy times including TZID, all-day and transparent events", () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART;TZID=Europe/Berlin:20261207T100000",
      "DTEND;TZID=Europe/Berlin:20261207T110000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20261208",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20261207T150000Z",
      "DTEND:20261207T160000Z",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20261207T170000Z",
      "DTEND:20261207T180000Z",
      "STATUS:CANCELLED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const busy = parseIcsBusy(feed, Date.UTC(2026, 11, 1), Date.UTC(2026, 11, 31));
    expect(busy).toEqual([
      { start: Date.UTC(2026, 11, 7, 9), end: Date.UTC(2026, 11, 7, 10) },
      { start: Date.UTC(2026, 11, 8), end: Date.UTC(2026, 11, 9) },
    ]);
  });
});

describe("routing forms", () => {
  const rules = [
    { id: "r1", match: "all" as const, conditions: [{ fieldId: "topic", op: "equals" as const, value: "Sales" }], target: { type: "event_type" as const, eventTypeId: "sales" } },
    { id: "r2", match: "any" as const, conditions: [{ fieldId: "topic", op: "in" as const, value: ["Technical support", "Setup"] }, { fieldId: "urgent", op: "not_empty" as const }], target: { type: "event_type" as const, eventTypeId: "support" } },
  ];
  const fallback = { type: "message" as const, message: "We will get back to you." };
  it("routes by first matching rule and falls back", () => {
    expect(evaluateRouting(rules, fallback, { topic: "sales" })).toEqual({ type: "event_type", eventTypeId: "sales" });
    expect(evaluateRouting(rules, fallback, { topic: "Setup" })).toEqual({ type: "event_type", eventTypeId: "support" });
    expect(evaluateRouting(rules, fallback, { topic: "Billing", urgent: "yes" })).toEqual({ type: "event_type", eventTypeId: "support" });
    expect(evaluateRouting(rules, fallback, { topic: "Billing" })).toEqual(fallback);
  });
});

describe("migrations", () => {
  it("splits statements without breaking triggers", () => {
    const sql = "CREATE TABLE a (x INT);\n--> statement-breakpoint\nCREATE TRIGGER t BEFORE INSERT ON a BEGIN SELECT 1; SELECT 2; END;\n--> statement-breakpoint\n-- comment only\n";
    expect(splitStatements(sql)).toEqual(["CREATE TABLE a (x INT);", "CREATE TRIGGER t BEFORE INSERT ON a BEGIN SELECT 1; SELECT 2; END;"]);
  });
});

describe("workflow templates", () => {
  it("interpolates variables and escapes for JSON bodies", () => {
    expect(interpolate("Hi {{attendee.name}}, {{ unknown }}!", { "attendee.name": "Ada" })).toBe("Hi Ada, !");
    expect(interpolate('{"n":"{{attendee.name}}"}', { "attendee.name": 'A "quoted" name' }, (s) => JSON.stringify(s).slice(1, -1))).toBe('{"n":"A \\"quoted\\" name"}');
  });
});
