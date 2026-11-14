import type { PushMessage, PushSender } from '../../src/ports/push-sender.js';

/** Records notifications instead of sending them. Tokens in `unregistered` answer as FCM does for stale ones. */
export class RecordingPushSender implements PushSender {
  readonly name = 'recording';
  readonly sent: { token: string; message: PushMessage }[] = [];
  readonly unregistered = new Set<string>();

  async send(token: string, message: PushMessage): Promise<'sent' | 'unregistered'> {
    if (this.unregistered.has(token)) return 'unregistered';
    this.sent.push({ token, message });
    return 'sent';
  }
}
