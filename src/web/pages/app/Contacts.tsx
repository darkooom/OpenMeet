import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Contact, Trash2 } from "lucide-react";
import { EmptyState, Input, PageHeader, Panel, Spinner } from "@/components/ui";
import { del, get } from "../../lib/api";

interface ContactDto {
  id: string;
  name: string;
  email: string;
  bookingsCount: number;
  lastBookedAt: number | null;
}

export default function Contacts() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const q = useQuery({ queryKey: ["contacts", search], queryFn: () => get<{ contacts: ContactDto[] }>(`/api/me/contacts?q=${encodeURIComponent(search)}`) });
  return (
    <div>
      <PageHeader title="Contacts" description="People who booked with you. Contacts are created automatically from bookings." />
      <Input type="search" aria-label="Search contacts" placeholder="Search by name or e-mail" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-4 max-w-sm" />
      <Panel>
        {q.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : !q.data?.contacts.length ? (
          <EmptyState icon={<Contact className="size-6" />} title={search ? "No matches" : "No contacts yet"}>
            {search ? "Try another search term." : "Everyone who books a meeting with you shows up here."}
          </EmptyState>
        ) : (
          <table className="w-full text-[13.5px]">
            <thead className="text-left text-[12.5px] text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">E-mail</th>
                <th className="px-5 py-2.5 text-right font-medium">Bookings</th>
                <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Last booking</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {q.data.contacts.map((c) => (
                <tr key={c.id}>
                  <td className="px-5 py-3 font-medium">{c.name}</td>
                  <td className="px-5 py-3">
                    <a href={`mailto:${c.email}`} className="text-accent">
                      {c.email}
                    </a>
                  </td>
                  <td className="px-5 py-3 text-right tabular">{c.bookingsCount}</td>
                  <td className="hidden px-5 py-3 text-muted sm:table-cell">{c.lastBookedAt ? new Date(c.lastBookedAt).toLocaleDateString() : "–"}</td>
                  <td className="pr-3">
                    <button
                      type="button"
                      aria-label={`Delete ${c.name}`}
                      onClick={async () => {
                        if (!confirm(`Delete contact ${c.name}? Bookings are kept.`)) return;
                        await del(`/api/me/contacts/${c.id}`);
                        void qc.invalidateQueries({ queryKey: ["contacts"] });
                      }}
                      className="rounded p-1.5 text-faint hover:text-danger"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
