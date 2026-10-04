import type { StableRelease } from './updatePolicy.js';

export declare function automaticUpdateFeed(
  release: Pick<StableRelease, 'version' | 'tagName'>,
  platform: string,
  arch: string,
): {
  readonly provider: 'generic';
  readonly url: string;
  readonly channel: string;
  readonly useMultipleRangeRequest: false;
};
