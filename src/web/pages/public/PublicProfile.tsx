import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { Spinner } from "@/components/ui";
import { get } from "../../lib/api";
import { minutesLabel } from "../../lib/format";
import { Avatar, PublicFrame, useEmbed } from "./BookingPage";

interface ProfileResponse {
  user: { name: string; username: string; avatarUrl: string | null; bio: string | null };
  eventTypes: { id: string; title: string; slug: string; description: string | null; duration: number; color: string; kind: string }[];
}

export function EventList({ items, base }: { items: ProfileResponse["eventTypes"]; base: string }) {
  if (items.length === 0) return <p className="px-6 py-10 text-muted">There are no public meeting types yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((e) => (
        <li key={e.id}>
          <Link to={`${base}/${e.slug}${window.location.search}`} className="group flex items-start gap-4 px-6 py-5 transition-colors hover:bg-raised/60">
            <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: e.color }} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink group-hover:text-accent">{e.title}</span>
              {e.description && <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{e.description}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted">
              <Clock className="size-3.5" aria-hidden /> {minutesLabel(e.duration)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function PublicProfile() {
  const { username = "" } = useParams();
  const embed = useEmbed();
  const q = useQuery({ queryKey: ["profile", username], queryFn: () => get<ProfileResponse>(`/api/public/users/${username}`), retry: false });
  return (
    <PublicFrame embed={embed}>
      {q.isLoading ? (
        <div className="grid min-h-[40vh] place-items-center">
          <Spinner />
        </div>
      ) : !q.data ? (
        <div className="mx-auto max-w-md py-20">
          <h1 className="text-2xl">This page does not exist</h1>
        </div>
      ) : (
        <div className="mx-auto max-w-[640px] overflow-hidden rounded-[16px] border border-line bg-surface">
          <header className="flex items-center gap-4 border-b border-line px-6 py-7">
            <Avatar name={q.data.user.name} src={q.data.user.avatarUrl} size={56} />
            <div>
              <h1 className="text-[24px] leading-tight">{q.data.user.name}</h1>
              {q.data.user.bio ? <p className="mt-1 text-[13.5px] text-muted">{q.data.user.bio}</p> : <p className="mt-1 text-[13.5px] text-muted">Pick a meeting type to see available times.</p>}
            </div>
          </header>
          <EventList items={q.data.eventTypes} base={`/u/${username}`} />
        </div>
      )}
    </PublicFrame>
  );
}
