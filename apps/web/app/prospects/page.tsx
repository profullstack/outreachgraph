export const metadata = { title: 'Prospects · OutreachGraph' };

export default function ProspectsPage() {
  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Prospects</h1>
        <p className="text-ink-muted text-sm">Ranked by opportunity</p>
      </header>

      <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
        Prospect search is not built yet. The API exposes <code>/api/v1/people/:id</code> with
        identities, signals and provenance.
      </p>
    </div>
  );
}
