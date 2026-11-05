/**
 * Errors thrown by the ledger before any row is written. All three are
 * validated in TypeScript before `postJournal` opens a transaction, so
 * throwing one of these guarantees nothing was persisted for that call.
 */

export class UnbalancedJournalError extends Error {
  constructor(totalCents: bigint) {
    super(
      `Journal postings must sum to 0 cents (debits == credits); got ${totalCents.toString()}`,
    );
    this.name = "UnbalancedJournalError";
  }
}

export class EmptyJournalError extends Error {
  constructor() {
    super("Journal entry must have at least one posting");
    this.name = "EmptyJournalError";
  }
}

export class ZeroAmountPostingError extends Error {
  constructor() {
    super("Journal posting amountCents must not be 0");
    this.name = "ZeroAmountPostingError";
  }
}
