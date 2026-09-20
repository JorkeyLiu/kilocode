// Test-only failure injection for S1 atomic rollback proof.
// Default closed: all flags false => production path behavior equivalent.
// Tests mutate these globals; never enable in production.
export const DispatchAtomicSeam = {
  // Inside create transaction, after all DB writes but before commit
  failCreateInsideTx: false,
  // Inside update transaction (insertSessionUpdateSucceededTx + event)
  failUpdateInsideTx: false,
  // Before delete's family removal (outer dispatch level)
  failDeleteBeforeTx: false,
  // Inside delete's canonical deleteFamilyWithDeleteTombstoneTx
  failDeleteInsideTx: false,
  // Inside revert transaction (session update + changefeed + event + operation)
  failRevertInsideTx: false,
  // Inside unrevert transaction (session clear + changefeed + event + operation)
  failUnrevertInsideTx: false,
}

// expose to core retention via global for cross-package injection without import cycle
if (typeof globalThis !== "undefined") {
  ;(globalThis as unknown as { __dispatchAtomicSeam?: typeof DispatchAtomicSeam }).__dispatchAtomicSeam =
    DispatchAtomicSeam
}
