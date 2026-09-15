// ------------------------------------------------------------------
// Settlement Engine
// ------------------------------------------------------------------
// Pure, deterministic, client-side mathematical logic.
// No AI / ML / external calls of any kind are used here on purpose:
// the result must be predictable, explainable, and easy to defend in a viva.
//
// Pipeline:
//   expenses            ->  expense-derived net balances
//   + settlement payments (real, recorded money movements)
//                       ->  final net balances
//                       ->  debtors / creditors
//                       ->  simplified settlement transactions
//
// IMPORTANT DESIGN NOTE
// ----------------------
// "Mark as Paid" does NOT just flip a status flag on one computed
// transaction. It creates a real settlement-payment record (from, to,
// amount, timestamp) that is permanently included in every future
// balance calculation, exactly like an expense would be. This is what
// lets the app correctly handle: partial payments, multiple payments,
// new expenses arriving after a payment, and debt direction flipping
// after a payment -- because the balance is always recomputed fresh
// from the full history (expenses + payments), never patched in place.
// ------------------------------------------------------------------

/**
 * Round to 2 decimal places safely (avoids floating point artifacts like 33.330000000000005).
 */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compute each member's net balance from a list of expenses only.
 * Positive = should receive, negative = owes, zero = settled (before payments).
 *
 * @param {Array<{uid:string,name:string}>} members
 * @param {Array<{amount:number, paidBy:string, participants:string[]}>} expenses
 * @returns {Object} map of uid -> net balance
 */
function computeNetBalances(members, expenses) {
  const balances = {};
  members.forEach((m) => { balances[m.uid] = 0; });

  expenses.forEach((exp) => {
    const participants = exp.participants || [];
    if (participants.length === 0 || !exp.paidBy) return;

    // Split amount evenly among participants, but keep the running total exact
    // by giving any leftover paise to the last participant (deterministic, no randomness).
    const shareBase = Math.floor((exp.amount / participants.length) * 100) / 100;
    const distributed = round2(shareBase * (participants.length - 1));
    const lastShare = round2(exp.amount - distributed);

    participants.forEach((uid, idx) => {
      const share = idx === participants.length - 1 ? lastShare : shareBase;
      if (balances[uid] === undefined) balances[uid] = 0;
      balances[uid] = round2(balances[uid] - share);
    });

    // The payer is credited the full amount they paid out.
    if (balances[exp.paidBy] === undefined) balances[exp.paidBy] = 0;
    balances[exp.paidBy] = round2(balances[exp.paidBy] + exp.amount);
  });

  return cleanBalances(balances);
}

/**
 * Apply a list of real settlement payments on top of expense-derived balances.
 *
 * A payment {from, to, amount} means "from" handed "to" real money.
 * That means:
 *  - the payer's balance goes UP by amount (they gave money away, so
 *    whatever they owed shrinks / whatever they're owed grows)
 *  - the recipient's balance goes DOWN by amount (they received money,
 *    so whatever they were owed shrinks / whatever they owe grows)
 *
 * This is order-independent and naturally supports multiple payments,
 * partial payments, and payments that overshoot into the opposite
 * direction of debt -- it's just arithmetic on a running ledger, the
 * same way expenses are.
 *
 * @param {Object} balances map of uid -> balance (from computeNetBalances)
 * @param {Array<{from:string, to:string, amount:number}>} payments
 * @returns {Object} new map of uid -> balance after payments
 */
function applyPaymentsToBalances(balances, payments) {
  const result = { ...balances };

  (payments || []).forEach((p) => {
    if (!p.from || !p.to || !p.amount) return;
    if (result[p.from] === undefined) result[p.from] = 0;
    if (result[p.to] === undefined) result[p.to] = 0;
    result[p.from] = round2(result[p.from] + p.amount);
    result[p.to] = round2(result[p.to] - p.amount);
  });

  return cleanBalances(result);
}

/**
 * Clean up floating-point dust: anything under half a paisa is treated as zero.
 */
function cleanBalances(balances) {
  const cleaned = { ...balances };
  Object.keys(cleaned).forEach((uid) => {
    if (Math.abs(cleaned[uid]) < 0.005) cleaned[uid] = 0;
  });
  return cleaned;
}

/**
 * Turn a set of net balances into the minimum practical number of transactions.
 *
 * Greedy debtor/creditor matching:
 *  1. Split members into creditors (balance > 0) and debtors (balance < 0).
 *  2. Sort each list by magnitude, descending.
 *  3. Repeatedly settle the largest debtor against the largest creditor for
 *     min(|debt|, credit); whichever hits zero first drops out of the list.
 *
 * This is deterministic and does not require AI: it is a well-known greedy
 * matching strategy that in practice produces at most (n - 1) transactions
 * for n participants with non-zero balances.
 *
 * @param {Object} balances map of uid -> net balance
 * @returns {Array<{from:string, to:string, amount:number}>}
 */
function simplifySettlements(balances) {
  const creditors = [];
  const debtors = [];

  Object.entries(balances).forEach(([uid, amount]) => {
    if (amount > 0.004) creditors.push({ uid, amount });
    else if (amount < -0.004) debtors.push({ uid, amount: -amount });
  });

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let i = 0, j = 0;

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amount = round2(Math.min(debtor.amount, creditor.amount));

    if (amount > 0.004) {
      transactions.push({ from: debtor.uid, to: creditor.uid, amount });
    }

    debtor.amount = round2(debtor.amount - amount);
    creditor.amount = round2(creditor.amount - amount);

    if (debtor.amount <= 0.004) i++;
    if (creditor.amount <= 0.004) j++;
  }

  return transactions;
}

/**
 * Full pipeline: expenses + recorded payments -> final balances -> simplified plan.
 *
 * @param {Array<{uid:string,name:string}>} members
 * @param {Array} expenses
 * @param {Array<{from:string,to:string,amount:number}>} payments
 */
function computeSettlementPlan(members, expenses, payments) {
  const expenseBalances = computeNetBalances(members, expenses);
  const balances = applyPaymentsToBalances(expenseBalances, payments || []);
  const transactions = simplifySettlements(balances);
  return { balances, transactions };
}
