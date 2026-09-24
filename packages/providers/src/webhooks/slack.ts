/**
 * An event, as a line in a Slack channel.
 *
 * A Slack incoming webhook takes a message, not an arbitrary JSON document, so
 * posting our envelope to one produces either an error or a wall of braces in
 * the channel. This turns each event into the sentence a person would have
 * typed: who, what, and the one detail worth a glance.
 *
 * Short on purpose. A channel that fills with paragraphs gets muted, and a
 * muted channel is a notification nobody receives. Everything else about the
 * event is one click away in the product.
 */

import type { OutboundEvent } from '@outreachgraph/domain';

export interface SlackMessage {
  readonly text: string;
}

/** Slack's mrkdwn treats these three as control characters. */
function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function str(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "*Jane Smith* (CTO, Acme)", or "someone" when the event carries nobody. */
function who(event: OutboundEvent): string {
  const person = event.data.person;
  if (!person) return 'someone';
  const role = [person.title, person.company].filter(Boolean).join(', ');
  return `*${escape(person.name)}*${role ? ` (${escape(role)})` : ''}`;
}

const NETWORK_LABEL: Readonly<Record<string, string>> = {
  email: 'email',
  bluesky: 'Bluesky',
  x: 'X',
  linkedin: 'LinkedIn',
};

function network(data: Record<string, unknown>): string {
  const value = str(data, 'network');
  return value ? (NETWORK_LABEL[value] ?? value) : 'a channel';
}

function action(data: Record<string, unknown>): string {
  return (str(data, 'action') ?? 'an action').replace(/_/g, ' ');
}

export function formatSlackMessage(event: OutboundEvent): SlackMessage {
  const data = event.data as Record<string, unknown>;

  switch (event.type) {
    case 'reply.received': {
      const subject = str(data, 'subject') ?? str(data, 'body');
      return {
        text: `:speech_balloon: ${who(event)} replied${subject ? `: “${escape(clip(subject, 140))}”` : ''}`,
      };
    }
    case 'link.clicked': {
      const url = str(data, 'url');
      return { text: `:link: ${who(event)} opened ${url ? `<${url}>` : 'a tracked link'}` };
    }
    case 'prospect.created':
      return { text: `:bust_in_silhouette: New prospect: ${who(event)}` };
    case 'recommendation.approved':
      return {
        text: `:white_check_mark: Approved ${escape(action(data))} for ${who(event)} on ${escape(network(data))}`,
      };
    case 'action.sent':
      return {
        text: `:outbox_tray: Sent ${escape(action(data))} to ${who(event)} on ${escape(network(data))}`,
      };
    case 'cadence.completed':
      return { text: `:checkered_flag: ${who(event)} finished a cadence` };
    case 'person.suppressed': {
      const reason = str(data, 'reason');
      return {
        text: `:no_entry: ${who(event)} will not be contacted again${reason ? ` (${escape(clip(reason, 80))})` : ''}`,
      };
    }
    case 'ping':
      return { text: ':wave: Test from OutreachGraph. This channel is connected.' };
  }
}
