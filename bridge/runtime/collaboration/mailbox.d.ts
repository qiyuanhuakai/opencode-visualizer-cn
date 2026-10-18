/** The bounded participant mailbox (task 39). */
export interface MailboxLimits {
  readonly messages: number;
  readonly bytes: number;
}

export interface Mailbox {
  readonly limits: MailboxLimits;
}

export function createMailbox(): Mailbox;
