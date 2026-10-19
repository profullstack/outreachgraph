/**
 * The pit.world network footer, fetched on the server and rendered as the last
 * thing in <body> on every page.
 *
 * The snippet is a self-contained fragment (a `<style>` scoped to `.pit-foot*`
 * and one `<nav data-pit-footer>`), cached for an hour. Any failure — timeout,
 * non-200, network — renders nothing: the footer must never break a page.
 */
const PIT_FOOTER_URL = 'https://pit.world/snippets/footer.html?site=outreachgraph.com';

export async function PitFooter() {
  try {
    const res = await fetch(PIT_FOOTER_URL, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    // One line: Next also copies this markup into its RSC payload script, and a
    // single-line fragment keeps the page's own markup readable around it.
    const html = (await res.text()).replace(/\s*\n\s*/g, '');
    if (!html.includes('data-pit-footer')) return null;
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return null;
  }
}
