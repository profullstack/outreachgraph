/**
 * The second look at blog, newsletter and podcast posts that the patterns in
 * @outreachgraph/ideas read as a signal: a pain, a product making money, an
 * idea someone says should exist.
 *
 * The patterns' commonest mistake on writing is general advice ("how to
 * validate an idea", "10 tips for bootstrappers"): it uses the words without
 * naming any product. This keeps only posts that point at a specific thing a
 * small team could build and sell, and names it in words that group with the
 * Reddit asks for the same thing.
 *
 * No model, a refusal or unreadable output all mean "no verdict".
 */

import type { TextModel } from './model';
import type { AskJudgeInput } from './judge-asks';

export interface SignalJudgement {
  readonly id: string;
  /** The post points at a specific product someone could build and sell. */
  readonly idea: boolean;
  readonly wants: readonly string[];
  readonly label: string;
  /** The post shows people paying for it, or saying they would. */
  readonly paid: boolean;
}

const SYSTEM = `You read posts from founders' blogs, newsletters, podcasts and Hacker News. You are building a list of products a small team could build and sell, with evidence that people want them.

Keep a post (idea: true) only when it points at one specific product or tool:
- a case study of a product that makes money ("built a scheduling tool for vets, now $8K/month"),
- a pain the author or their customers have that a tool would fix,
- a product the author says someone should build, or one they built for themselves or one customer.

Not an idea:
- general advice (how to validate, how to market, how to price), news, opinion, hiring, fundraising;
- a list of many unrelated ideas with nothing specific;
- a launch of a general-purpose platform;
- a revenue story that never says what the product does. "I built a $1M app in 5 hours", "How I grew my mobile app to $17K per month" and "Bro's directory website does $35k per month" are NOT ideas unless the summary names what the product does for whom. If you cannot say what it does in a few concrete words, answer idea: false.

The label must name what the product does, never how well it sells or what kind of software it is. Bad labels: "successful mobile app", "$20K/month app", "online game", "AI tool", "SaaS business". Good labels: "Excel formula generator", "vet clinic appointment scheduler", "screenshot to code converter". No numbers or money in labels.

For each post return:
- idea: true or false.
- wants: when idea is true, what the product does, 1 to 6 short phrases (3-8 words each), most important first.
- label: when idea is true, a 2-6 word generic name for the product, the words a person asking for it on Reddit would use ("veterinary appointment scheduler", "podcast transcription tool").
- paid: true only when the post shows customers paying or says people would pay.

Return exactly one result for every post, in the order given. Never leave a post out.
Return only JSON: {"results": [{"id": "<id>", "idea": true, "wants": ["..."], "label": "...", "paid": false}]}.`;

/** Judge up to ten posts per call. Returns [] when the model gives nothing usable. */
export async function judgeSignals(
  model: TextModel,
  posts: readonly AskJudgeInput[],
): Promise<SignalJudgement[]> {
  if (!posts.length) return [];
  const user = posts
    .map(
      (post) =>
        `--- id: ${post.id}\ntitle: ${post.title}\n${post.text.replace(/\s+/g, ' ').slice(0, 1200)}`,
    )
    .join('\n\n');
  const generated = await model.generate({ system: SYSTEM, user, maxTokens: 3000 });
  if (generated.refused) return [];
  return parseSignalJudgements(generated.text);
}

export function parseSignalJudgements(raw: string): SignalJudgement[] {
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
      id: String(entry.id).trim(),
      idea: entry.idea === true,
      wants: Array.isArray(entry.wants)
        ? entry.wants
            .map((w) => String(w).trim())
            .filter(Boolean)
            .slice(0, 6)
        : [],
      label: typeof entry.label === 'string' ? entry.label.trim().slice(0, 80) : '',
      paid: entry.paid === true,
    }));
}
