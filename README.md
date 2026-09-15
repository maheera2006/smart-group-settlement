# Smart Group Settlement

A group expense app that doesn't stop at "who owes whom" — it simplifies the
resulting debt network into the **fewest practical settlement transactions**.

Existing splitters (Splitwise and similar) already calculate individual
balances. The gap: with different participants per expense, multiple payers,
and repeated expenses, a group can still end up with a confusing web of
payments even after balances are known. This app adds a deterministic
optimization step on top of the balances to collapse that web into a minimal
payment plan.

```
A: +₹800   B: -₹500   C: -₹300        B → A ₹500
                            ─────►     C → A ₹300
```

## Tech stack

- Vanilla HTML, CSS, JavaScript (no framework, no build step)
- Firebase Authentication (email/password)
- Cloud Firestore (auth + persistent, shared group data)
- Zero paid APIs, zero AI APIs — the settlement algorithm is plain
  deterministic math run entirely in the browser (`js/settlement.js`)

## Project structure

```
smart-group-settlement/
├── index.html            # Single-page app shell (all views)
├── css/style.css         # All styling
├── js/
│   ├── firebase-config.js  # Firebase project config (fill in your own)
│   ├── settlement.js        # Deterministic settlement algorithm (pure functions)
│   ├── auth.js               # Sign up / log in / log out / auth state
│   └── app.js                 # Groups, expenses, members, settlements UI logic
├── firestore.rules       # Security rules — deploy these before demoing
└── README.md
```

## Setup (5 minutes)

1. **Create a Firebase project**
   Go to the [Firebase console](https://console.firebase.google.com), click
   "Add project", and follow the prompts (Google Analytics is optional and
   can be skipped).

2. **Register a Web App**
   In your new project, click the `</>` icon to add a web app. Firebase will
   show you a `firebaseConfig` object — copy it.

3. **Paste your config**
   Open `js/firebase-config.js` and replace the placeholder values with the
   config you copied.

4. **Enable Email/Password auth**
   In the console: *Authentication → Sign-in method → Email/Password → Enable*.

5. **Create a Firestore database**
   In the console: *Firestore Database → Create database*. Start in
   **production mode** (the rules in this repo lock it down properly).

6. **Deploy the security rules**
   Easiest path — paste the contents of `firestore.rules` into
   *Firestore Database → Rules* in the console and click **Publish**.

   Or, with the Firebase CLI:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase init firestore   # point it at this project, keep existing rules file
   firebase deploy --only firestore:rules
   ```

7. **Run it**
   Open `index.html` with VS Code's **Live Server** extension (or any static
   file server — Firebase Auth requires `http://` or `https://`, not
   `file://`). No `npm install` needed for the app itself.

## Demo script (3–5 minutes)

1. Sign up two or three accounts (e.g. `asha@test.com`, `rahul@test.com`,
   `priya@test.com`) — needed because members are added by email.
2. Log in as one user, create a group, add the others by email.
3. Add a few expenses with **different participants each time** — this is
   the part that differentiates the project from a plain calculator:
   - Dinner ₹1200 paid by Asha, split A/B/C
   - Taxi ₹300 paid by Rahul, split A/C only
   - Hotel ₹4000 paid by Priya, split A/B/C
4. Open the **Settlements** tab and show the simplified payment plan next to
   the raw per-expense list — point out it's fewer transactions than the
   number of expenses/participant pairs would otherwise imply.
5. Click **Mark as Paid** on one transaction and show the state persists
   (paid transactions are stored in `settlementStatus`, keyed by the payer/
   payee pair, and are only shown as paid if the amount still matches what
   was last computed — new expenses reopen a stale "paid" mark instead of
   hiding a real balance).

## How the settlement algorithm works (`js/settlement.js`)

No AI or external service is used — this is plain, explainable arithmetic:

1. **Per-expense shares**: for each expense, divide the amount evenly among
   its participants (any leftover paisa from rounding goes to the last
   participant, deterministically — no randomness).
2. **Net balance**: for every member, `balance = total paid − total share owed`.
   Positive = should receive money, negative = owes money, zero = settled.
3. **Simplification**: split members into creditors and debtors, sort each
   list by amount descending, and greedily match the largest debtor against
   the largest creditor for `min(debt, credit)` until both lists are empty.
   This is a standard, deterministic greedy strategy and in practice yields
   at most `members − 1` transactions.

## Data model

```
users/{uid}                                  { name, email }
groups/{groupId}                             { name, ownerId, memberIds[], memberInfo{} }
groups/{groupId}/expenses/{expenseId}        { description, amount, paidBy, participants[], date, category }
groups/{groupId}/payments/{paymentId}        { from, to, amount, groupId, timestamp }
```

`payments` is an append-only ledger of real settlement payments, created
whenever someone clicks **Mark as Paid**. It is *not* a status flag on a
computed transaction — see the next section for why that distinction matters.

## How "Mark as Paid" actually works

Earlier versions of this app stored paid status as a flag keyed to a specific
computed transaction (`fromUid__toUid`). That approach breaks the moment a
new expense arrives after a payment: the settlement plan recalculates from
expenses alone, the old flag no longer matches the new amount, and the debt
appears to come back — even though it was genuinely paid.

The fix: **every balance is computed from expenses *and* the full payment
ledger, every time**, using the same net-balance model the settlement
algorithm already uses:

```
balance[payer]     += payment.amount   (they gave money away)
balance[recipient] -= payment.amount   (they received money)
```

This is why "Mark as Paid" lets you edit the amount before recording it — a
partial payment just adds a smaller entry to the ledger, and the remainder
stays outstanding automatically.

**Worked example** (this exact scenario is covered by an automated test in
`js/settlement.js`'s test suite):

1. Expenses put Priya at −₹450 (she owes Maheera ₹450).
2. Priya pays. Recorded as `{from: priya, to: maheera, amount: 450}`.
   Balances recompute: everyone is at ₹0.
3. A new expense, *Snacks ₹150* (paid by Priya, split Priya + Maheera), is
   added. Raw expense balances now show Priya at −₹375 — but the payment is
   still in the ledger, so the **final** balance is `−375 + 450 = +75` for
   Priya, and `+375 − 450 = −75` for Maheera.
4. The settlement plan correctly flips direction: **Maheera → Priya ₹75**,
   not the stale "Priya → Maheera ₹375" a status-flag approach would show.

This also means multiple payments, payments from different people, and a
page refresh all behave correctly — none of them are special-cased, because
they all just add or read entries from the same ledger. Each recorded
payment appears in a **Payment history** list under Settlements with an
**Undo** button, in case one was recorded by mistake.

## Security

`firestore.rules` restricts every read/write on a group, its expenses, and
its settlement status to users whose uid appears in that group's
`memberIds` array. A signed-in user can never read or write another group's
data. See the rules file for the exact conditions.

## Explicitly out of scope (by design)

AI/OCR receipt scanning, payment gateways, UPI/bank integration, WhatsApp/
Maps APIs, cryptocurrency, an admin panel, or a custom backend server. The
project is meant to be demonstrable, explainable, and buildable at ₹0.

## Known edge cases handled

- Equal and unequal splits, and expenses with only a subset of members.
- A payer who is not themselves a participant in the expense.
- Decimal amounts (rounding dust is normalized to zero).
- Members with a zero balance are never shown as debtors/creditors.
- Partial payments (editable amount when marking as paid).
- Multiple payments accumulating correctly toward the same or different debts.
- New expenses arriving after a payment — the plan recalculates from the
  full ledger, including flipping debt direction if that's now correct.
- Page refresh — nothing is client-side state; everything is re-derived
  from Firestore each time the view loads.

All of the above (except the Firestore-specific ones, which need a live
project) are covered by an automated test suite for `js/settlement.js` — see
the "Testing the algorithm standalone" section below.

## Testing the algorithm standalone

`js/settlement.js` has no dependency on Firebase or the DOM — it's plain
functions over plain objects — so it can be sanity-checked with Node
directly, without a browser or a Firebase project:

```bash
node -e "
  eval(require('fs').readFileSync('js/settlement.js', 'utf8'));
  const members = [{uid:'a'},{uid:'b'},{uid:'c'}];
  const expenses = [{amount:900, paidBy:'a', participants:['a','b','c']}];
  const payments = [{from:'b', to:'a', amount:300}];
  console.log(computeSettlementPlan(members, expenses, payments));
"
```
