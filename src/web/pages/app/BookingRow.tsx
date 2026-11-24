import { Link } from "react-router";
import { Badge, cn } from "@/components/ui";
import { fmtRange, relativeDay } from "../../lib/format";
import type { BookingDetails } from "../../lib/types";
import { LocationIcon } from "../public/BookingPage";

export function StatusBadge({ status, noShow }: { status: BookingDetails["status"]; noShow?: boolean }) {
  if (noShow) return <Badge tone="warn">No-show</Badge>;
  if (status === "pending") return <Badge tone="warn">Awaiting confirmation</Badge>;
  if (status === "cancelled") return <Badge tone="danger">Cancelled</Badge>;
  if (status === "rejected") return <Badge tone="danger">Declined</Badge>;
  return null;
}

export function BookingRow({ b, tz, compact }: { b: BookingDetails; tz: string; compact?: boolean }) {
  const attendees = b.attendees.filter((a) => a.status === "active");
  const who = (attendees.length ? attendees : b.attendees).map((a) => a.name).join(", ");
  return (
    <li>
      <Link to={`/app/bookings/${b.id}`} className={cn("grid grid-cols-[92px_1fr] items-start gap-4 px-5 transition-colors hover:bg-raised/60 sm:grid-cols-[120px_1fr_auto]", compact ? "py-3" : "py-4")}>
        <div className="tabular">
          <p className="text-[13px] font-medium">{relativeDay(b.startAt, tz)}</p>
          <p className="text-[12.5px] text-muted">{fmtRange(b.startAt, b.endAt, tz)}</p>
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate font-medium">
            <span className="size-2 shrink-0 rounded-full" style={{ background: b.eventType.color }} aria-hidden />
            <span className="truncate">{b.eventType.title}</span>
          </p>
          <p className="truncate text-[13px] text-muted">
            {who}
            {b.hosts.length > 1 || b.eventType.teamId ? ` · with ${b.hosts.map((h) => h.name).join(", ")}` : ""}
          </p>
        </div>
        <div className="col-start-2 flex items-center gap-2 sm:col-start-auto">
          <StatusBadge status={b.status} noShow={b.noShow} />
          {b.locationType && <LocationIcon type={b.locationType} className="size-4 text-faint" />}
        </div>
      </Link>
    </li>
  );
}
