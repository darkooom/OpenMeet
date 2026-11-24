import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Button, PageHeader, Panel, Select, Spinner } from "@/components/ui";
import { get } from "../../lib/api";

interface Analytics {
  total: number;
  cancelled: number;
  cancellationRate: number;
  noShowRate: number;
  avgLeadTimeHours: number | null;
  byEventType: { label: string; count: number }[];
  byMember: { label: string; count: number }[];
  bySource: { label: string; count: number }[];
  byCampaign: { label: string; count: number }[];
  heatmap: number[][];
  conversion: { eventType: string; views: number; bookings: number; rate: number | null }[];
}

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

function Bars({ items, empty }: { items: { label: string; count: number }[]; empty: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <p className="px-5 py-5 text-[13px] text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2.5 px-5 py-4">
      {items.slice(0, 8).map((i) => (
        <li key={i.label} className="grid grid-cols-[minmax(0,140px)_1fr_36px] items-center gap-3 text-[13px]">
          <span className="truncate">{i.label}</span>
          <span className="h-2 rounded-full bg-raised">
            <span className="block h-2 rounded-full bg-accent" style={{ width: `${(i.count / max) * 100}%` }} />
          </span>
          <span className="text-right tabular text-muted">{i.count}</span>
        </li>
      ))}
    </ul>
  );
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function AnalyticsPage() {
  const [days, setDays] = useState(90);
  const from = Date.now() - days * 86_400_000;
  const q = useQuery({ queryKey: ["analytics", days], queryFn: () => get<Analytics>(`/api/insights/analytics?from=${from}&to=${Date.now() + 60 * 86_400_000}`) });
  const a = q.data;
  const heatMax = a ? Math.max(1, ...a.heatmap.flat()) : 1;

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Aggregated booking numbers. Booking pages count views without cookies or personal data."
        actions={
          <>
            <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 12 months</option>
            </Select>
            <a href={`/api/insights/bookings.csv?from=${from}`} download>
              <Button>
                <Download className="size-4" /> CSV
              </Button>
            </a>
          </>
        }
      />
      {!a ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-6">
          <dl className="grid grid-cols-2 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface sm:grid-cols-4 sm:divide-x sm:divide-line">
            {[
              { l: "Bookings", v: String(a.total) },
              { l: "Cancellation rate", v: pct(a.cancellationRate) },
              { l: "No-show rate", v: pct(a.noShowRate) },
              { l: "Avg. lead time", v: a.avgLeadTimeHours == null ? "–" : a.avgLeadTimeHours < 48 ? `${Math.round(a.avgLeadTimeHours)} h` : `${Math.round(a.avgLeadTimeHours / 24)} days` },
            ].map((s) => (
              <div key={s.l} className="px-5 py-4">
                <dt className="text-[12.5px] text-muted">{s.l}</dt>
                <dd className="mt-1 font-display text-[28px] font-semibold leading-none tabular">{s.v}</dd>
              </div>
            ))}
          </dl>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="By event type">
              <Bars items={a.byEventType} empty="No bookings in this period." />
            </Panel>
            <Panel title="By team member">
              <Bars items={a.byMember} empty="No bookings in this period." />
            </Panel>
            <Panel title="Where bookings come from">
              <Bars items={a.bySource} empty="No bookings in this period." />
            </Panel>
            <Panel title="Campaigns (utm_campaign)">
              <Bars items={a.byCampaign} empty="Add ?utm_campaign=… to your booking links to see campaigns here." />
            </Panel>
          </div>
          <Panel title="Popular times">
            <div className="overflow-x-auto px-5 py-4">
              <table className="text-[11px] text-faint">
                <thead>
                  <tr>
                    <th />
                    {Array.from({ length: 24 }, (_, h) => (
                      <th key={h} className="w-6 font-normal tabular">
                        {h % 3 === 0 ? h : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
                    <tr key={wd}>
                      <th className="pr-2 text-left font-normal">{WD[wd]}</th>
                      {a.heatmap[wd]!.map((v, h) => (
                        <td key={h} className="p-0.5">
                          <span className="block size-5 rounded-[3px] bg-accent" style={{ opacity: v === 0 ? 0.06 : 0.2 + (v / heatMax) * 0.8 }} title={`${WD[wd]} ${h}:00 – ${v} bookings`} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="Booking page conversion">
            <table className="w-full text-[13.5px]">
              <thead className="text-left text-[12.5px] text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2.5 font-medium">Event type</th>
                  <th className="px-5 py-2.5 text-right font-medium">Page views</th>
                  <th className="px-5 py-2.5 text-right font-medium">Bookings</th>
                  <th className="px-5 py-2.5 text-right font-medium">Conversion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {a.conversion.map((c) => (
                  <tr key={c.eventType}>
                    <td className="px-5 py-2.5">{c.eventType}</td>
                    <td className="px-5 py-2.5 text-right tabular">{c.views}</td>
                    <td className="px-5 py-2.5 text-right tabular">{c.bookings}</td>
                    <td className="px-5 py-2.5 text-right tabular">{c.rate == null ? "–" : pct(c.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}
    </div>
  );
}
