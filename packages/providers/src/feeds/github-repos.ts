/**
 * New GitHub repositories as a launch source.
 *
 * A repository created this week whose name, description or topics match a
 * term is somebody building in the space, usually before they have posted
 * about it anywhere. The owner is the author: a person, or an organization
 * whose public profile names a site and sometimes an address.
 *
 * Unauthenticated search allows ten requests a minute; one is made per term.
 */

import { GitHubClient, GitHubRateLimitError, type GitHubClientOptions } from '../github/client';
import {
  excerpt,
  FeedRateLimitError,
  type FeedPost,
  type FeedSearchInput,
  type FeedSource,
} from './source';

export interface GitHubRepoSourceOptions extends GitHubClientOptions {
  readonly client?: GitHubClient;
}

export class GitHubRepoSource implements FeedSource {
  readonly network = 'github' as const;
  readonly slug = 'github';
  readonly displayName = 'GitHub';

  readonly #client: GitHubClient;

  constructor(options: GitHubRepoSourceOptions = {}) {
    this.#client = options.client ?? new GitHubClient(options);
  }

  async search(input: FeedSearchInput): Promise<readonly FeedPost[]> {
    const terms = [...new Set(input.terms.map((t) => t.trim()).filter((t) => t.length > 0))];
    const limit = Math.min(input.limit ?? 30, 100);
    const created = (input.since ?? new Date(Date.now() - 7 * 86_400_000))
      .toISOString()
      .slice(0, 10);
    const posts: FeedPost[] = [];
    const seen = new Set<string>();

    for (const term of terms) {
      let items;
      try {
        ({ items } = await this.#client.searchRepos(
          `"${term.replace(/"/g, '')}" created:>=${created} fork:false`,
          limit,
        ));
      } catch (error) {
        if (error instanceof GitHubRateLimitError) throw new FeedRateLimitError('github');
        throw error;
      }
      for (const repo of items ?? []) {
        if (seen.has(repo.full_name) || !repo.owner?.login) continue;
        seen.add(repo.full_name);
        if (input.since && Date.parse(repo.created_at) < input.since.getTime()) continue;
        posts.push({
          network: 'github',
          externalId: `github:${repo.full_name}`,
          authorHandle: repo.owner.login,
          authorUrl: `https://github.com/${repo.owner.login}`,
          url: repo.html_url,
          title: repo.full_name,
          text: excerpt(
            [repo.description, repo.topics?.length ? repo.topics.join(' ') : '']
              .filter(Boolean)
              .join('\n') || repo.full_name,
          ),
          postedAt: repo.created_at,
          container: repo.owner.type === 'Organization' ? 'GitHub organization' : 'GitHub',
        });
      }
    }
    return posts;
  }
}
