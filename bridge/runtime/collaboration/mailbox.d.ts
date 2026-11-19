/** The participant mailbox is opaque to App; the delegation service consumes it. */
declare const mailboxBrand: unique symbol;
export interface Mailbox {
  readonly [mailboxBrand]: true;
}

export function createMailbox(): Mailbox;
