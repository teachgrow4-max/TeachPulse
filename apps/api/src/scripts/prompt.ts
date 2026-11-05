import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * Minimal terminal prompts for operator scripts.
 *
 * `askSecret` never echoes what is typed. On a real terminal it reads raw keystrokes; when stdin is
 * not a TTY (a pipe, a CI secret) it simply reads one line, since there is nothing to echo.
 */

export interface Prompter {
  readonly interactive: boolean;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
}

type TtyReadable = Readable & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

function readLine(input: Readable, output: Writable, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, output, terminal: false });
    output.write(question);
    let answered = false;
    rl.once('line', (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!answered) reject(new Error('input closed before an answer was given'));
    });
  });
}

function readSecretRaw(input: TtyReadable, output: Writable, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(question);
    let value = '';

    const finish = (): void => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else if (ch >= ' ') {
          value += ch;
        }
      }
    };

    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
  });
}

export function createPrompter(
  input: TtyReadable = process.stdin,
  output: Writable = process.stdout,
): Prompter {
  const interactive = Boolean(input.isTTY);
  return {
    interactive,
    ask: (question) => readLine(input, output, question),
    askSecret: (question) =>
      interactive ? readSecretRaw(input, output, question) : readLine(input, output, question),
  };
}
