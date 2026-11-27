import type { SecretBox } from '@pb/crypto';
import type { Db } from '@pb/db';
import type { AccessTokenCache, GoogleOAuth } from '@pb/drive';
import type { MessageSender } from '@pb/messaging';
import type { ObjectStorage } from '@pb/storage';

export type WorkerDeps = {
  db: Db;
  storage: ObjectStorage;
  secretBox: SecretBox | null;
  /** null = GOOGLE_CLIENT_ID/SECRET missing: Drive jobs fail with `drive_not_connected`. */
  google: GoogleOAuth | null;
  driveTokens: AccessTokenCache;
  /** Path of the ffmpeg binary. */
  ffmpegPath: string;
  /** Injectable clock (tests). */
  now?: () => Date;
  log?: (msg: string) => void;
  /** Fetch for config assets (frame overlays, fonts, …). Defaults to global fetch. */
  fetchAsset?: typeof fetch;
  /** URL prefixes config assets may be fetched from (default: PB_ASSET_URL_PREFIXES / media base). */
  assetUrlPrefixes?: readonly string[];
  /** F9: the platform's WhatsApp/e-mail sender. Absent = deliveries fail with a clear message. */
  messaging?: MessageSender;
  /** F9: base of the `/s/:code` links in messages (PB_SHORT_LINK_BASE / PB_PUBLIC_API_URL). */
  shortLinkBase?: string | null;
};

/**
 * A failure with a known cause. `permanent` = retrying will not help until somebody acts
 * (owner reconnects Drive, …); the job is marked failed and Studio shows `message`.
 */
export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'JobError';
  }
}
