import { classify, disabledResearch, summary } from './triage.ts';
import { RetryLater, TARGET } from './types.ts';
import type { QueueStore, ResearchProvider, SummarySink, ThreadReader } from './types.ts';
export interface DeliveryStore extends QueueStore { beginSending(id: string): void; markUncertain(id: string): void }
export interface WorkerOptions {
  store: DeliveryStore;
  reader: ThreadReader;
  sink: SummarySink;
  provider?: ResearchProvider;
  approvedExternalProviderId?: string;
  allowPrivateDelivery?: boolean;
  clock?: () => number;
  maxAttempts?: number;
  signal?: AbortSignal;
}
export async function workOne(options: WorkerOptions): Promise<'idle' | 'prepared' | 'sent' | 'retry' | 'uncertain'> {
  if (options.signal?.aborted) return 'idle';
  const clock = options.clock ?? Date.now;
  const job = options.store.claim(clock());
  if (!job) return 'idle';
  let sending = false;
  try {
    let prepared = job.prepared;
    if (!prepared) {
      const thread = await options.reader.fetchThread(job.mention);
      const classification = classify(job.mention.text);
      const provider = options.provider ?? disabledResearch;
      if (provider.external && options.approvedExternalProviderId !== provider.id) throw new Error('External provider approval required');
      // Slack content is untrusted source material. A future AI adapter must
      // isolate it as data, constrain tools, and disclose its data handling.
      const research = await provider.research({ mention: job.mention, thread, classification });
      prepared = { classification, research, text: summary(job.mention, classification, research, thread) };
      options.store.savePrepared(job.id, prepared);
    }
    if (!options.allowPrivateDelivery) {
      // Park the prepared job, with no network send and no busy-loop retry.
      options.store.retry(job.id, clock() + 24 * 60 * 60 * 1000, options.maxAttempts ?? 5);
      return 'prepared';
    }
    if (options.signal?.aborted) {
      options.store.retry(job.id, clock() + 60_000, options.maxAttempts ?? 5);
      return 'retry';
    }
    options.store.beginSending(job.id);
    sending = true;
    await options.sink.sendPrivate({ recipientId: TARGET.userId, text: prepared.text, idempotencyKey: job.id });
    options.store.complete(job.id, clock());
    return 'sent';
  } catch (error) {
    // A Slack rate-limit response is a definite failure, so safe to retry. Other
    // send failures might have posted successfully: quarantine for review.
    if (sending && !(error instanceof RetryLater)) {
      options.store.markUncertain(job.id);
      return 'uncertain';
    }
    const delay = error instanceof RetryLater ? error.delayMs : Math.min(60_000 * 2 ** (job.attempts - 1), 60 * 60 * 1000);
    options.store.retry(job.id, clock() + delay, options.maxAttempts ?? 5);
    return 'retry';
  }
}
