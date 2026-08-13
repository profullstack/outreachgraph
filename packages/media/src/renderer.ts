/**
 * The renderer boundary.
 *
 * Vendor objects do not leak past this file: a renderer takes a `VideoScript`
 * and returns a `RenderedVideo`, and callers never see a provider payload.
 * Adding a second video vendor means adding an adapter here, not changing
 * `renderVideoForDraft`.
 */

import type { VideoScript } from '@outreachgraph/domain';

export interface RenderOptions {
  /** Aspect ratio hint. Outreach clips are watched in an inbox, so 16:9. */
  readonly aspectRatio?: string;
  /** Voice identifier, interpreted by the renderer. */
  readonly voice?: string;
  /** Visual direction. Never contains claims — those live in the script. */
  readonly styleDirection?: string;
}

export interface RenderedVideo {
  /** Where the finished file can be fetched. */
  readonly assetUrl: string;
  readonly durationSeconds: number;
  /** Renderer identifier, recorded so a bad batch can be found later. */
  readonly renderer: string;
}

export interface VideoRenderer {
  readonly name: string;
  render(script: VideoScript, options?: RenderOptions): Promise<RenderedVideo>;
}

export class RenderFailedError extends Error {
  readonly renderer: string;

  constructor(renderer: string, message: string) {
    super(message);
    this.name = 'RenderFailedError';
    this.renderer = renderer;
  }
}

/**
 * A renderer that produces a deterministic descriptor instead of a file.
 *
 * The pipeline has to stay runnable end to end with no API keys, and video is
 * the most expensive thing in it. This keeps approval-queue and worker tests
 * honest without spending anything.
 */
export class FixtureVideoRenderer implements VideoRenderer {
  readonly name = 'fixture';
  readonly calls: VideoScript[] = [];

  readonly #baseUrl: string;

  constructor(baseUrl = 'https://fixtures.outreachgraph.test/video') {
    this.#baseUrl = baseUrl;
  }

  async render(script: VideoScript): Promise<RenderedVideo> {
    this.calls.push(script);

    // Stable across runs: the same script always yields the same URL, so a
    // fixture-backed test can assert on it.
    const slug = fingerprint(script.segments.map((segment) => segment.text).join(' '));

    return {
      assetUrl: `${this.#baseUrl}/${slug}.mp4`,
      durationSeconds: script.estimatedSeconds,
      renderer: this.name,
    };
  }
}

/**
 * The shape this adapter needs from a generative media library.
 *
 * Declared structurally rather than imported so the package does not take a
 * dependency on a specific implementation. `@profullstack/transcoder`'s
 * genmedia layer satisfies it.
 */
export interface GenMediaClient {
  generateVideo(options: {
    prompt: string;
    aspectRatio?: string;
    [key: string]: unknown;
  }): Promise<{
    toFile(path: string): Promise<string>;
    meta?: Record<string, unknown>;
  }>;
}

export interface GenMediaRendererOptions {
  readonly client: GenMediaClient;
  /** Called with the local path of the rendered file; returns a fetchable URL. */
  readonly publish: (localPath: string) => Promise<string>;
  /** Directory for intermediate files. */
  readonly workDir?: string;
  readonly name?: string;
}

/**
 * Renders through a generative video model.
 *
 * The prompt is assembled from the script's spoken text plus style direction.
 * Nothing is added to what is said: the script already passed the grounding
 * gates, and a renderer that embellished it would defeat them.
 */
export class GenMediaVideoRenderer implements VideoRenderer {
  readonly name: string;

  readonly #client: GenMediaClient;
  readonly #publish: (localPath: string) => Promise<string>;
  readonly #workDir: string;

  constructor(options: GenMediaRendererOptions) {
    this.#client = options.client;
    this.#publish = options.publish;
    this.#workDir = options.workDir ?? '/tmp/outreachgraph-video';
    this.name = options.name ?? 'genmedia';
  }

  async render(script: VideoScript, options: RenderOptions = {}): Promise<RenderedVideo> {
    const spoken = script.segments.map((segment) => segment.text).join(' ');
    const direction = options.styleDirection ?? 'A single presenter speaking directly to camera.';

    try {
      const generated = await this.#client.generateVideo({
        prompt: `${direction}\n\nThe presenter says, word for word:\n"${spoken}"`,
        aspectRatio: options.aspectRatio ?? '16:9',
        ...(options.voice ? { voice: options.voice } : {}),
      });

      const localPath = await generated.toFile(`${this.#workDir}/${Date.now()}.mp4`);
      const assetUrl = await this.#publish(localPath);

      return { assetUrl, durationSeconds: script.estimatedSeconds, renderer: this.name };
    } catch (error) {
      throw new RenderFailedError(
        this.name,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * A short stable hash, used only for fixture URLs.
 *
 * @param value - Text to fingerprint
 * @returns 8 hex characters
 */
function fingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
