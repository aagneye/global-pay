/**
 * A notification to a phone. Keep it generic: no amounts or names on the lock screen. `data` carries only
 * IDs; the app fetches the rest over the authenticated API.
 */
export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * Sends push notifications. Production: FCM (FcmPushSender). Without credentials: DisabledPushSender,
 * and the apps poll instead.
 */
export interface PushSender {
  readonly name: string;
  /**
   * `unregistered`: the token is no longer valid (app uninstalled, token rotated), so forget it.
   * `skipped`: push isn't configured. Throws on other failures.
   */
  send(token: string, message: PushMessage): Promise<'sent' | 'unregistered' | 'skipped'>;
}
