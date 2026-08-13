/**
 * `@outreachgraph/media` — personalised video, as a rendition of an approved
 * draft (PRD §14, §15).
 *
 * The package deliberately owns no judgement of its own. Grounding comes from
 * `@outreachgraph/ai`, permission from `@outreachgraph/policy`, and the human
 * approval requirement is checked against stored approvals. What is left here
 * is script assembly and the renderer boundary.
 */

export {
  buildVideoScript,
  splitSentences,
  type BuildScriptInput,
  type BuildScriptResult,
} from './script';

export {
  FixtureVideoRenderer,
  GenMediaVideoRenderer,
  RenderFailedError,
  type GenMediaClient,
  type GenMediaRendererOptions,
  type RenderedVideo,
  type RenderOptions,
  type VideoRenderer,
} from './renderer';

export {
  renderVideoForDraft,
  RENDER_REFUSALS,
  VIDEO_CAPABILITY_FLAG,
  type RenderContext,
  type RenderRefusal,
  type RenderResult,
} from './render';
