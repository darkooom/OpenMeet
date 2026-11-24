import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@/components/ui";
import { get } from "../../lib/api";
import { PublicFrame, useEmbed } from "./BookingPage";
import { EventList } from "./PublicProfile";

export default function TeamProfile() {
  const { teamSlug = "" } = useParams();
  const embed = useEmbed();
  const q = useQuery({
    queryKey: ["team-profile", teamSlug],
    queryFn: () => get<{ team: { name: string; description: string | null }; eventTypes: { id: string; title: string; slug: string; description: string | null; duration: number; color: string; kind: string }[] }>(`/api/public/teams/${teamSlug}`),
    retry: false,
  });
  return (
    <PublicFrame embed={embed}>
      {q.isLoading ? (
        <Spinner />
      ) : !q.data ? (
        <div className="mx-auto max-w-md py-20">
          <h1 className="text-2xl">This team page does not exist</h1>
        </div>
      ) : (
        <div className="mx-auto max-w-[640px] overflow-hidden rounded-[16px] border border-line bg-surface">
          <header className="border-b border-line px-6 py-7">
            <h1 className="text-[24px]">{q.data.team.name}</h1>
            {q.data.team.description && <p className="mt-1 text-muted">{q.data.team.description}</p>}
          </header>
          <EventList items={q.data.eventTypes} base={`/team/${teamSlug}`} />
        </div>
      )}
    </PublicFrame>
  );
}
