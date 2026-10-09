import type { Credentials } from './config.ts';
import { assertCredential } from './config.ts';
import { StartupFailure, startupFailure } from './diagnostics.ts';
import type { FailurePhase } from './diagnostics.ts';

export interface PrivateInput {
  isTTY?: boolean; isRaw?: boolean;
  setRawMode(raw: boolean): unknown;
  resume(): unknown; pause(): unknown;
  on(event: 'data', listener: (data: Buffer) => void): unknown;
  off(event: 'data', listener: (data: Buffer) => void): unknown;
}
export interface PrivateOutput { isTTY?: boolean; write(text: string): unknown }
export function readHiddenToken(label: string, input: PrivateInput = process.stdin, output: PrivateOutput = process.stdout, signal?: AbortSignal): Promise<string> {
  if (!input.isTTY || !output.isTTY) return Promise.reject(new StartupFailure('app_token', 'private_terminal'));
  return new Promise((resolve, reject) => {
    const previousRaw = Boolean(input.isRaw); let value = '';
    let finished = false;
    const finish = (failure?: 'cancelled' | 'format') => {
      if (finished) return;
      finished = true; signal?.removeEventListener('abort', cancel);
      input.off('data', handle); input.setRawMode(previousRaw); input.pause(); output.write('\n');
      if (failure) { value = ''; reject(new StartupFailure('app_token', failure)); }
      else { const result = value; value = ''; resolve(result); }
    };
    const cancel = () => finish('cancelled');
    const handle = (data: Buffer) => {
      for (const character of data.toString('utf8')) {
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u0003' || character === '\u0004') { finish('cancelled'); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character === '\u0015') value = '';
        else if (/^[A-Za-z0-9_-]$/.test(character)) value += character;
        else { finish('format'); return; }
        if (value.length > 4096) { finish('format'); return; }
      }
    };
    // Disable echo before publishing the prompt, including an immediate paste.
    input.setRawMode(true); input.on('data', handle); output.write(`${label} (hidden): `); input.resume();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
export async function promptCredentials(signal?: AbortSignal): Promise<Credentials> {
  const read = async (label: string, phase: Extract<FailurePhase, 'app_token' | 'user_token' | 'bot_token'>) => {
    let value: string;
    try { value = await readHiddenToken(label, process.stdin, process.stdout, signal); }
    catch (error) { throw error instanceof StartupFailure ? new StartupFailure(phase, error.reason) : startupFailure(error, phase); }
    assertCredential(value, phase);
    return value;
  };
  return {
    appToken: await read('Radar app-level token', 'app_token'),
    userToken: await read('Slack monitored-user token', 'user_token'),
    botToken: await read('Radar bot token', 'bot_token')
  };
}
