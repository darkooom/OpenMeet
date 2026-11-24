import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Copy, ExternalLink, Lock, Plus, Users } from "lucide-react";
import { Badge, Button, EmptyState, PageHeader, Panel, Spinner, Switch } from "@/components/ui";
import { get, post, put } from "../../lib/api";
import { minutesLabel } from "../../lib/format";
import { useUser } from "../../lib/session";
import type { EventTypeDto } from "../../lib/types";
import { CopyButton } from "./Overview";

const KIND_LABEL: Record<string, string> = { one_on_one: "One-on-one", group: "Group", collective: "Collective", round_robin: "Round robin" };

export function eventTypeUrl(et: EventTypeDto, username: string) {
  return et.team ? `${window.location.origin}/team/${et.team.slug}/${et.slug}` : `${window.location.origin}/u/${username}/${et.slug}`;
}

export default function EventTypes() {
  const user = useUser();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["event-types"], queryFn: () => get<{ eventTypes: EventTypeDto[] }>("/api/event-types") });

  const toggle = async (et: EventTypeDto, isActive: boolean) => {
    await put(`/api/event-types/${et.id}`, { ...et, isActive, redirectUrl: et.redirectUrl ?? "" });
    void qc.invalidateQueries({ queryKey: ["event-types"] });
  };
  const duplicate = async (et: EventTypeDto) => {
    await post(`/api/event-types/${et.id}/duplicate`);
    void qc.invalidateQueries({ queryKey: ["event-types"] });
  };

  const groups = new Map<string, { title: string; items: EventTypeDto[] }>();
  for (const et of q.data?.eventTypes ?? []) {
    const key = et.team?.id ?? "personal";
    const g = groups.get(key) ?? { title: et.team ? et.team.name : "Personal", items: [] };
    g.items.push(et);
    groups.set(key, g);
  }

  return (
    <div>
      <PageHeader
        title="Event types"
        description="The meetings people can book with you or your teams."
        actions={
          <Link to="/app/event-types/new">
            <Button variant="primary">
              <Plus className="size-4" /> New event type
            </Button>
          </Link>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : groups.size === 0 ? (
        <Panel>
          <EmptyState icon={<CalendarClock className="size-6" />} title="Create your first event type" action={<Link to="/app/event-types/new"><Button variant="primary">New event type</Button></Link>}>
            For example a 15 minute intro call or a 60 minute onboarding session.
          </EmptyState>
        </Panel>
      ) : (
        <div className="flex flex-col gap-6">
          {[...groups.entries()].map(([key, g]) => (
            <Panel key={key} title={g.title}>
              <ul className="divide-y divide-line">
                {g.items.map((et) => (
                  <li key={et.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                    <span className="h-9 w-1 shrink-0 rounded-full" style={{ background: et.color }} aria-hidden />
                    <Link to={`/app/event-types/${et.id}`} className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 font-medium">
                        {et.title}
                        {et.isPrivate && <Lock className="size-3.5 text-faint" aria-label="Private" />}
                        {!et.isActive && <Badge>Off</Badge>}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-muted">
                        <span>{minutesLabel(et.duration)}</span>
                        <span>{KIND_LABEL[et.kind]}</span>
                        {et.kind === "group" && (
                          <span className="flex items-center gap-1">
                            <Users className="size-3" /> {et.seats} seats
                          </span>
                        )}
                        <span className="truncate text-faint">/{et.team ? `team/${et.team.slug}` : `u/${user.username}`}/{et.slug}</span>
                      </p>
                    </Link>
                    <div className="flex items-center gap-1.5">
                      {!et.isPrivate && <CopyButton value={eventTypeUrl(et, user.username)} label="Copy link" />}
                      {!et.isPrivate && (
                        <a href={eventTypeUrl(et, user.username)} target="_blank" rel="noreferrer" aria-label="Open booking page" className="grid size-8 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-raised hover:text-ink">
                          <ExternalLink className="size-4" />
                        </a>
                      )}
                      <button type="button" onClick={() => duplicate(et)} aria-label="Duplicate" className="grid size-8 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-raised hover:text-ink">
                        <Copy className="size-4" />
                      </button>
                      <div className="w-12">
                        <Switch label={<span className="sr-only">Bookable</span>} checked={et.isActive} onChange={(v) => toggle(et, v)} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
