/**
 * The second look at Reddit posts that read like somebody asking for a tool.
 *
 * The patterns in @outreachgraph/ideas are cheap and loose. Their commonest
 * mistake is a founder pitching their own tool in the shape of a question ("I
 * built X, would you use it?") or a builder fishing for ideas. This throws
 * those out and names what each real ask wants, in words that group well.
 *
 * No model, a refusal or unreadable output all mean "no verdict": the caller
 * keeps the pattern verdicts and says the list was not judged.
 */

import type { TextModel } from './model';

export interface AskJudgeInput {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface AskJudgement {
  readonly id: string;
  readonly ask: boolean;
  readonly wants: readonly string[];
  readonly label: string;
}

const SYSTEM = `You read Reddit posts and decide whether each one is a person asking for a site, app, tool or service that does specific things. You are building a list of things people want that a small team could build.

An ask: "is there an app that tracks X and alerts me", "looking for a tool to do Y", "I wish someone made Z", "how do you keep track of W" when they clearly want a tool for it.
Not an ask: someone promoting what they built, asking for business advice, hiring, looking for a person or a vendor (an accountant, a 3PL, a cofounder), opinions, rants, surveys, or asking whether their own idea is good.

For each post return:
- ask: true or false.
- wants: when it is an ask, the specific things they want it to do, 1 to 6 short phrases in their words (3-8 words each), most important first. Never pad with generic wishes like "easy to use" unless they said it.
- label: when it is an ask, a 2-6 word name for the thing, generic enough that other people asking for the same thing would share it ("habit tracker with streaks", "multi-currency payment processor").

Return exactly one result for every post, in the order given, including the ones that are not asks (ask: false). Never leave a post out.
Return only JSON: {"results": [{"id": "<id>", "ask": true, "wants": ["..."], "label": "..."}]}.`;

/** Judge up to ten posts per call. Returns [] when the model gives nothing usable. */
export async function judgeAsks(
  model: TextModel,
  posts: readonly AskJudgeInput[],
): Promise<AskJudgement[]> {
  if (!posts.length) return [];
  const user = posts
    .map(
      (post) =>
        `--- id: ${post.id}\ntitle: ${post.title}\n${post.text.replace(/\s+/g, ' ').slice(0, 1200)}`,
    )
    .join('\n\n');
  const generated = await model.generate({ system: SYSTEM, user, maxTokens: 3000 });
  if (generated.refused) return [];
  return parseJudgements(generated.text);
}

export function parseJudgements(raw: string): AskJudgement[] {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return [];
  let parsed: { results?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  return (parsed.results ?? [])
    .filter((entry) => typeof entry.id === 'string' || typeof entry.id === 'number')
    .map((entry) => ({
      id: String(entry.id).trim().replace(/^t3_/, ''),
      ask: entry.ask === true,
      wants: Array.isArray(entry.wants)
        ? entry.wants
            .map((w) => String(w).trim())
            .filter(Boolean)
            .slice(0, 6)
        : [],
      label: typeof entry.label === 'string' ? entry.label.trim().slice(0, 80) : '',
    }));
}
