import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CalendarDays, Download } from "lucide-react";
import { Button, EmptyState, PageHeader, Panel, Spinner, Tabs } from "@/components/ui";
import { get } from "../../lib/api";
import { useUser } from "../../lib/session";
import type { BookingDetails } from "../../lib/types";
import { BookingRow } from "./BookingRow";

type Status = "upcoming" | "pending" | "past" | "cancelled";

export default function Bookings() {
  const user = useUser();
  const [status, setStatus] = useState<Status>("upcoming");
  const q = useInfiniteQuery({
    queryKey: ["bookings", status],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => get<{ bookings: BookingDetails[]; nextCursor: number | null }>(`/api/bookings?status=${status}&limit=30${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const seen = new Set<string>();
  const items = (q.data?.pages.flatMap((p) => p.bookings) ?? []).filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));

  return (
    <div>
      <PageHeader
        title="Bookings"
        description="Everything people booked with you and your teams."
        actions={
          <a href="/api/insights/bookings.csv" download>
            <Button>
              <Download className="size-4" /> Export CSV
            </Button>
          </a>
        }
      />
      <Tabs
        value={status}
        onChange={setStatus}
        items={[
          { value: "upcoming", label: "Upcoming" },
          { value: "pending", label: "Unconfirmed" },
          { value: "past", label: "Past" },
          { value: "cancelled", label: "Cancelled" },
        ]}
      />
      <Panel className="mt-5">
        {q.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<CalendarDays className="size-6" />} title={status === "upcoming" ? "No upcoming bookings" : status === "pending" ? "Nothing waiting for confirmation" : status === "past" ? "No past bookings yet" : "No cancelled bookings"}>
            {status === "upcoming" ? "New bookings appear here as soon as someone picks a time." : null}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">{items.map((b) => <BookingRow key={b.id} b={b} tz={user.timezone} />)}</ul>
        )}
      </Panel>
      {q.hasNextPage && (
        <div className="mt-4">
          <Button onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
