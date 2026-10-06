import type { Classification, Mention, ResearchProvider, ResearchResult, ThreadContext } from './types.ts';

// Deliberately local, deterministic heuristics. This is not AI understanding.
export function classify(text: string): Classification {
  const result: Classification = { categories: ['attention'], urgency: /\b(urgent|asap|blocked|critical)\b/i.test(text) ? 'high' : 'normal', method: 'local-rules' };
  if (/\?|\b(can|could|would|will) you\b|\b(what|why|how|when|where|which)\b/i.test(text)) result.categories.push('question');
  if (/\b(please|can you|could you|need you to|assigned|action item|review|send|fix|prepare|follow up)\b/i.test(text)) result.categories.push('task');
  if (/\b(remind|reminder|don't forget|do not forget|remember to)\b/i.test(text)) result.categories.push('reminder');
  const deadline = text.match(/\b(?:by|before|due)\s+(?:tomorrow|today|EOD|end of day|\d{1,2}(?::\d{2})?\s*(?:am|pm)?|monday|tuesday|wednesday|thursday|friday)\b/i);
  if (deadline) result.deadlineText = deadline[0];
  return result;
}
export const disabledResearch: ResearchProvider = {
  id: 'disabled', external: false,
  async research() { return { status: 'disabled' }; }
};
export function summary(mention: Mention, classification: Classification, research: ResearchResult, thread: ThreadContext): string {
  const excerpt = mention.text.replace(/<@([A-Z0-9]+)>/g, '@$1').slice(0,700);
  const link = `https://app.slack.com/archives/${mention.channelId}/p${mention.ts.replace('.', '')}`;
  return [
    "Thread Watch",
    `Triage (local rules): ${classification.categories.join(', ')} · ${classification.urgency} priority`,
    classification.deadlineText ? `Possible deadline: ${classification.deadlineText} (not scheduled)` : '',
    `From ${mention.authorId}: ${excerpt}`,
    `Thread context: ${thread.messages.length} messages${thread.truncated ? ' (truncated)' : ''}`,
    research.status === 'disabled' ? 'Research: disabled; no external provider selected.' : `Research: ${research.text?.slice(0, 600) ?? 'No findings'}\n${(research.sources ?? []).slice(0,3).join('\n')}`,
    link
  ].filter(Boolean).join('\n').slice(0,2800);
}
