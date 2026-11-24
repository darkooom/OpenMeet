import { describe, expect, it } from "vitest";
import { availabilityWindows, computeSlots, type HostSchedule, type SlotQuery } from "../../src/server/services/slots";
import { zonedToUtc } from "../../src/shared/time";

const weekdays9to17withLunch: HostSchedule = {
  timezone: "Europe/Berlin",
  rules: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startMinute: 9 * 60, endMinute: 12 * 60 },
    { weekday, startMinute: 13 * 60, endMinute: 17 * 60 },
  ]),
  overrides: [],
};

function query(partial: Partial<SlotQuery>): SlotQuery {
  return {
    rangeStart: zonedToUtc("2026-12-07", 0, "Europe/Berlin"),
    rangeEnd: zonedToUtc("2026-12-08", 0, "Europe/Berlin"),
    now: Date.UTC(2026, 11, 1),
    duration: 30,
    minNoticeMinutes: 0,
    bookingWindowDays: 60,
    bufferBefore: 0,
    bufferAfter: 0,
    mode: "any",
    hosts: [{ userId: "u1", schedule: weekdays9to17withLunch, busy: [] }],
    ...partial,
  };
}
const berlin = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedToUtc(date, h! * 60 + m!, "Europe/Berlin");
};

describe("slot engine", () => {
  it("produces slots inside working hours and respects the lunch break", () => {
    const slots = computeSlots(query({}));
    expect(slots).toHaveLength(14);
    expect(slots[0]!.start).toBe(berlin("2026-12-07", "09:00"));
    expect(slots.some((s) => s.start === berlin("2026-12-07", "12:00"))).toBe(false);
    expect(slots.at(-1)!.start).toBe(berlin("2026-12-07", "16:30"));
  });

  it("returns nothing on weekends", () => {
    const slots = computeSlots(query({ rangeStart: berlin("2026-12-05", "00:00"), rangeEnd: berlin("2026-12-07", "00:00") }));
    expect(slots).toHaveLength(0);
  });

  it("excludes busy time including buffers", () => {
    const busy = [{ start: berlin("2026-12-07", "10:00"), end: berlin("2026-12-07", "10:30") }];
    const slots = computeSlots(query({ bufferAfter: 15, hosts: [{ userId: "u1", schedule: weekdays9to17withLunch, busy }] }));
    const starts = slots.map((s) => s.start);
    expect(starts).not.toContain(berlin("2026-12-07", "10:00"));
    // 09:30 + 30min + 15min buffer overlaps 10:00 busy block
    expect(starts).not.toContain(berlin("2026-12-07", "09:30"));
    expect(starts).toContain(berlin("2026-12-07", "09:00"));
    expect(starts).toContain(berlin("2026-12-07", "10:30"));
  });

  it("applies minimum notice and booking window", () => {
    const now = berlin("2026-12-07", "11:10");
    const slots = computeSlots(query({ now, minNoticeMinutes: 120 }));
    expect(slots[0]!.start).toBe(berlin("2026-12-07", "13:30"));
    const far = computeSlots(query({ now: berlin("2026-10-01", "00:00"), bookingWindowDays: 30 }));
    expect(far).toHaveLength(0);
  });

  it("respects date overrides: holidays and custom hours", () => {
    const schedule: HostSchedule = {
      ...weekdays9to17withLunch,
      overrides: [{ date: "2026-12-07", kind: "unavailable", startMinute: null, endMinute: null }],
    };
    expect(computeSlots(query({ hosts: [{ userId: "u1", schedule, busy: [] }] }))).toHaveLength(0);
    const custom: HostSchedule = {
      ...weekdays9to17withLunch,
      overrides: [{ date: "2026-12-07", kind: "available", startMinute: 18 * 60, endMinute: 19 * 60 }],
    };
    const slots = computeSlots(query({ hosts: [{ userId: "u1", schedule: custom, busy: [] }] }));
    expect(slots.map((s) => s.start)).toEqual([berlin("2026-12-07", "18:00"), berlin("2026-12-07", "18:30")]);
  });

  it("blocks a partial-day range", () => {
    const schedule: HostSchedule = {
      ...weekdays9to17withLunch,
      overrides: [{ date: "2026-12-07", kind: "unavailable", startMinute: 9 * 60, endMinute: 11 * 60 }],
    };
    const slots = computeSlots(query({ hosts: [{ userId: "u1", schedule, busy: [] }] }));
    expect(slots[0]!.start).toBe(berlin("2026-12-07", "11:00"));
  });

  it("enforces max bookings per day and per week", () => {
    const host = { userId: "u1", schedule: weekdays9to17withLunch, busy: [], bookingsPerDay: { "2026-12-07": 2 }, bookingsPerWeek: { "2026-12-07": 5 } };
    expect(computeSlots(query({ maxPerDay: 2, hosts: [host] }))).toHaveLength(0);
    expect(computeSlots(query({ maxPerDay: 3, hosts: [host] }))).toHaveLength(14);
    expect(computeSlots(query({ maxPerWeek: 5, hosts: [host] }))).toHaveLength(0);
  });

  it("keeps wall-clock working hours across the DST switch", () => {
    const rangeStart = berlin("2026-10-23", "00:00");
    const rangeEnd = berlin("2026-10-27", "00:00");
    const slots = computeSlots(query({ rangeStart, rangeEnd, now: Date.UTC(2026, 9, 1), duration: 60 }));
    const fridayFirst = slots.find((s) => s.start >= berlin("2026-10-23", "00:00"))!;
    const mondayFirst = slots.find((s) => s.start >= berlin("2026-10-26", "00:00"))!;
    expect(new Date(fridayFirst.start).toISOString()).toBe("2026-10-23T07:00:00.000Z");
    expect(new Date(mondayFirst.start).toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("collective mode requires all hosts, any mode merges hosts", () => {
    const busyA = [{ start: berlin("2026-12-07", "09:00"), end: berlin("2026-12-07", "12:00") }];
    const hosts = [
      { userId: "a", schedule: weekdays9to17withLunch, busy: busyA },
      { userId: "b", schedule: weekdays9to17withLunch, busy: [] },
    ];
    const all = computeSlots(query({ mode: "all", hosts }));
    expect(all.every((s) => s.start >= berlin("2026-12-07", "13:00"))).toBe(true);
    expect(all[0]!.hostIds.sort()).toEqual(["a", "b"]);
    const any = computeSlots(query({ mode: "any", hosts }));
    expect(any[0]!.start).toBe(berlin("2026-12-07", "09:00"));
    expect(any[0]!.hostIds).toEqual(["b"]);
  });

  it("supports hosts in different time zones", () => {
    const ny: HostSchedule = { timezone: "America/New_York", rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 }], overrides: [] };
    const slots = computeSlots(query({ rangeEnd: berlin("2026-12-08", "06:00"), hosts: [{ userId: "ny", schedule: ny, busy: [] }] }));
    expect(new Date(slots[0]!.start).toISOString()).toBe("2026-12-07T14:00:00.000Z");
  });

  it("keeps open group slots bookable", () => {
    const start = berlin("2026-12-07", "10:00");
    const busy = [{ start, end: start + 30 * 60_000 }];
    const slots = computeSlots(query({ hosts: [{ userId: "u1", schedule: weekdays9to17withLunch, busy }], openGroupStarts: [{ start, hostIds: ["u1"] }] }));
    const g = slots.find((s) => s.start === start);
    expect(g?.joinsBooking).toBe(true);
  });

  it("availability windows merge adjacent intervals", () => {
    const sched: HostSchedule = { timezone: "UTC", rules: [{ weekday: 1, startMinute: 0, endMinute: 600 }, { weekday: 1, startMinute: 600, endMinute: 1440 }], overrides: [] };
    const w = availabilityWindows(sched, Date.UTC(2026, 11, 7), Date.UTC(2026, 11, 8));
    expect(w).toEqual([{ start: Date.UTC(2026, 11, 7), end: Date.UTC(2026, 11, 8) }]);
  });
});
