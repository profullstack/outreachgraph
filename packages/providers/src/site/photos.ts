/**
 * Portraits from HTML the crawler already read. The site must name the owner
 * in a Person.image or in the image's alt text; proximity to a name and the
 * company's OpenGraph card are not enough to assign somebody a face.
 */
import type { CandidatePhoto } from '../provider';
import { publicPhotoUrl } from '../photo';
import { collapse, decodeEntities } from './extract';

function nameKey(value: string): string {
  return collapse(value).normalize('NFC').toLowerCase();
}

function imageUrl(value: unknown, pageUrl: string): string | undefined {
  if (typeof value === 'string') return publicPhotoUrl(decodeEntities(value), pageUrl);
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = imageUrl(item, pageUrl);
      if (url) return url;
    }
  } else if (value && typeof value === 'object') {
    const image = value as Record<string, unknown>;
    return imageUrl(image.contentUrl, pageUrl) ?? imageUrl(image.url, pageUrl);
  }
  return undefined;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value);
}

export function extractNamedPhotos(
  html: string,
  pageUrl: string,
  people: readonly string[],
  /** Shared across pages so a reused image cannot acquire different owners. */
  owners = new Map<string, Set<string>>(),
): ReadonlyMap<string, CandidatePhoto> {
  const names = new Map(people.map((name) => [nameKey(name), name]));
  const found = new Map<string, CandidatePhoto>();
  // Track all claimants, even names the model did not extract. A shared logo
  // or placeholder labelled as several people is nobody's portrait.
  const add = (name: string, url: string | undefined): void => {
    if (!url) return;
    const key = nameKey(name);
    owners.set(url, (owners.get(url) ?? new Set()).add(key));
    const person = names.get(key);
    if (person && !found.has(person)) found.set(person, { url, pageUrl });
  };

  // Schema permits nested Person objects (author, employee, mainEntity),
  // arrays, @graph, and ImageObject values. Walk those without guessing names.
  const visit = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 20) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const object = node as Record<string, unknown>;
    const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
    if (types.includes('Person') && typeof object.name === 'string') {
      add(object.name, imageUrl(object.image, pageUrl));
    }
    for (const child of Object.values(object)) visit(child, depth + 1);
  };
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of uncommented.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(match[1] ?? ''));
    } catch {
      // A broken structured-data block must not hide the page's named images.
    }
  }

  const visible = uncommented.replace(
    /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi,
    '',
  );
  for (const match of visible.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const label = attribute(tag, 'alt');
    if (!label) continue;
    const name = label
      .trim()
      .replace(
        /^(?:(?:profile\s+)?(?:photo(?:graph)?|portrait|headshot|picture|image)(?:\s+of)?\s*[:\-]?\s+)/i,
        '',
      )
      .replace(
        /\s*[,\-–—:]?\s+(?:(?:profile\s+)?photo(?:graph)?|portrait|headshot|picture|image)$/i,
        '',
      );
    const width = Number(attribute(tag, 'width'));
    const height = Number(attribute(tag, 'height'));
    if ((width > 0 && width < 32) || (height > 0 && height < 32)) continue;
    // Lazy-load attributes carry the portrait when src is a placeholder.
    const url =
      imageUrl(attribute(tag, 'data-src'), pageUrl) ??
      imageUrl(attribute(tag, 'data-lazy-src'), pageUrl) ??
      imageUrl(attribute(tag, 'src'), pageUrl);
    add(name, url);
  }

  for (const [person, photo] of found) {
    if (owners.get(photo.url)?.size !== 1) found.delete(person);
  }
  return found;
}
