// ------------------------------------------------------------------
// App: groups, expenses, members, settlements, navigation
// ------------------------------------------------------------------

const App = (() => {
  let user = null;
  let currentGroup = null; // { id, name, ownerId, memberIds, memberInfo }
  let currentExpenses = [];
  let currentPayments = []; // real settlement-payment ledger entries: {id, from, to, amount, timestamp}

  const rupee = (n) => `₹${n.toFixed(2).replace(/\.00$/, "")}`;

  // ---------------- Navigation ----------------

  function goToDashboard() {
    currentGroup = null;
    showView("view-dashboard");
    loadGroups();
  }

  document.querySelectorAll('[data-nav="dashboard"]').forEach((el) => {
    el.addEventListener("click", goToDashboard);
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.groupTab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      ["expenses", "members", "settlements"].forEach((t) => {
        document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
      });
      if (tab === "settlements") renderSettlementsView();
    });
  });

  function closeModals() {
    document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
  }
  document.querySelectorAll("[data-close-modal]").forEach((btn) => btn.addEventListener("click", closeModals));

  // ---------------- Dashboard / Groups ----------------

  async function loadGroups() {
    const listEl = document.getElementById("groups-list");
    const emptyEl = document.getElementById("groups-empty");
    listEl.innerHTML = "";

    const snap = await db.collection("groups")
      .where("memberIds", "array-contains", user.uid)
      .get();

    if (snap.empty) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");

    snap.forEach((doc) => {
      const g = doc.data();
      const card = document.createElement("div");
      card.className = "group-card";
      card.innerHTML = `
        <h3>${escapeHtml(g.name)}</h3>
        <div class="meta">${g.memberIds.length} member${g.memberIds.length === 1 ? "" : "s"}</div>
      `;
      card.addEventListener("click", () => openGroup(doc.id));
      listEl.appendChild(card);
    });
  }

  document.getElementById("open-create-group").addEventListener("click", () => {
    document.getElementById("new-group-name").value = "";
    document.getElementById("new-group-members").value = "";
    document.getElementById("create-group-error").textContent = "";
    document.getElementById("modal-create-group").classList.remove("hidden");
  });

  document.getElementById("submit-create-group").addEventListener("click", async () => {
    const name = document.getElementById("new-group-name").value.trim();
    const emailsRaw = document.getElementById("new-group-members").value.trim();
    const errorEl = document.getElementById("create-group-error");
    errorEl.textContent = "";

    if (!name) {
      errorEl.textContent = "Please enter a group name.";
      return;
    }

    const emails = emailsRaw
      ? emailsRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
      : [];

    try {
      const memberIds = [user.uid];
      const memberInfo = { [user.uid]: { name: user.name, email: user.email } };

      for (const email of emails) {
        if (email === user.email.toLowerCase()) continue;
        const q = await db.collection("users").where("email", "==", email).limit(1).get();
        if (q.empty) {
          errorEl.textContent = `No registered user found with email: ${email}`;
          return;
        }
        const doc = q.docs[0];
        if (!memberIds.includes(doc.id)) {
          memberIds.push(doc.id);
          memberInfo[doc.id] = { name: doc.data().name, email: doc.data().email };
        }
      }

      await db.collection("groups").add({
        name,
        ownerId: user.uid,
        memberIds,
        memberInfo,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      closeModals();
      showToast("Group created.");
      loadGroups();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  // ---------------- Group detail ----------------

  async function openGroup(groupId) {
    const doc = await db.collection("groups").doc(groupId).get();
    if (!doc.exists) { showToast("Group not found.", true); return; }

    const g = doc.data();
    currentGroup = { id: doc.id, ...g };

    document.getElementById("group-title").textContent = g.name;
    document.querySelector('.tab-btn[data-group-tab="expenses"]').click();

    showView("view-group");
    await loadGroupData();
    renderMembers();
    populateExpenseFormOptions();
  }

  function renderMembers() {
    const listEl = document.getElementById("members-list");
    listEl.innerHTML = "";
    currentGroup.memberIds.forEach((uid) => {
      const info = currentGroup.memberInfo[uid] || { name: uid, email: "" };
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <div class="li-main">
          <div class="li-title">${escapeHtml(info.name)} ${uid === currentGroup.ownerId ? "<span class=\"category-badge\">Owner</span>" : ""}</div>
          <div class="li-sub">${escapeHtml(info.email)}</div>
        </div>
      `;
      listEl.appendChild(item);
    });
  }

  document.getElementById("open-add-member").addEventListener("click", () => {
    document.getElementById("add-member-email").value = "";
    document.getElementById("add-member-error").textContent = "";
    document.getElementById("modal-add-member").classList.remove("hidden");
  });

  document.getElementById("submit-add-member").addEventListener("click", async () => {
    const email = document.getElementById("add-member-email").value.trim().toLowerCase();
    const errorEl = document.getElementById("add-member-error");
    errorEl.textContent = "";

    if (!email) { errorEl.textContent = "Enter an email."; return; }

    const q = await db.collection("users").where("email", "==", email).limit(1).get();
    if (q.empty) { errorEl.textContent = "No registered user found with that email."; return; }

    const doc = q.docs[0];
    if (currentGroup.memberIds.includes(doc.id)) {
      errorEl.textContent = "That person is already a member.";
      return;
    }

    const newMemberIds = [...currentGroup.memberIds, doc.id];
    const newMemberInfo = { ...currentGroup.memberInfo, [doc.id]: { name: doc.data().name, email: doc.data().email } };

    await db.collection("groups").doc(currentGroup.id).update({
      memberIds: newMemberIds,
      memberInfo: newMemberInfo
    });

    currentGroup.memberIds = newMemberIds;
    currentGroup.memberInfo = newMemberInfo;

    closeModals();
    showToast("Member added.");
    renderMembers();
    populateExpenseFormOptions();
  });

  // ---------------- Expenses + Payments (loaded together: balances need both) ----------------

  /**
   * Loads both the expense list and the settlement-payment ledger for the
   * current group, then re-renders everything that depends on balances.
   * These two must always be loaded together because the true balance is
   * expenses combined with real recorded payments -- never one alone.
   */
  async function loadGroupData() {
    const [expensesSnap, paymentsSnap] = await Promise.all([
      db.collection("groups").doc(currentGroup.id).collection("expenses").orderBy("date", "desc").get(),
      db.collection("groups").doc(currentGroup.id).collection("payments").orderBy("timestamp", "desc").get()
    ]);

    currentExpenses = expensesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    currentPayments = paymentsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    renderExpenses();
    renderBalances();

    // Keep the settlements tab live if it's the one currently open.
    if (!document.getElementById("tab-settlements").classList.contains("hidden")) {
      renderSettlementsView();
    }
  }

  function renderExpenses() {
    const listEl = document.getElementById("expenses-list");
    const emptyEl = document.getElementById("expenses-empty");
    listEl.innerHTML = "";

    if (currentExpenses.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");

    currentExpenses.forEach((exp) => {
      const payerName = nameOf(exp.paidBy);
      const participantNames = exp.participants.map(nameOf).join(", ");
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <div class="li-main">
          <div class="li-title">${escapeHtml(exp.description)}${exp.category ? `<span class="category-badge">${escapeHtml(exp.category)}</span>` : ""}</div>
          <div class="li-sub">Paid by ${escapeHtml(payerName)} · Split among ${escapeHtml(participantNames)} · ${exp.date}</div>
        </div>
        <div class="li-amount">${rupee(exp.amount)}</div>
      `;
      listEl.appendChild(item);
    });
  }

  function nameOf(uid) {
    return (currentGroup.memberInfo[uid] && currentGroup.memberInfo[uid].name) || "Unknown";
  }

  function populateExpenseFormOptions() {
    const paidBySelect = document.getElementById("expense-paid-by");
    const participantsEl = document.getElementById("expense-participants");
    paidBySelect.innerHTML = "";
    participantsEl.innerHTML = "";

    currentGroup.memberIds.forEach((uid) => {
      const info = currentGroup.memberInfo[uid];
      const opt = document.createElement("option");
      opt.value = uid;
      opt.textContent = info.name;
      if (uid === user.uid) opt.selected = true;
      paidBySelect.appendChild(opt);

      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" value="${uid}" checked /> ${escapeHtml(info.name)}`;
      participantsEl.appendChild(label);
    });
  }

  document.getElementById("open-add-expense").addEventListener("click", () => {
    document.getElementById("expense-desc").value = "";
    document.getElementById("expense-amount").value = "";
    document.getElementById("expense-category").value = "";
    document.getElementById("expense-date").value = new Date().toISOString().slice(0, 10);
    document.getElementById("add-expense-error").textContent = "";
    populateExpenseFormOptions();
    document.getElementById("modal-add-expense").classList.remove("hidden");
  });

  document.getElementById("submit-add-expense").addEventListener("click", async () => {
    const description = document.getElementById("expense-desc").value.trim();
    const amount = parseFloat(document.getElementById("expense-amount").value);
    const paidBy = document.getElementById("expense-paid-by").value;
    const category = document.getElementById("expense-category").value.trim();
    const date = document.getElementById("expense-date").value;
    const participants = Array.from(
      document.querySelectorAll("#expense-participants input:checked")
    ).map((cb) => cb.value);

    const errorEl = document.getElementById("add-expense-error");
    errorEl.textContent = "";

    if (!description) { errorEl.textContent = "Enter a description."; return; }
    if (!amount || amount <= 0) { errorEl.textContent = "Enter a valid amount greater than 0."; return; }
    if (!date) { errorEl.textContent = "Pick a date."; return; }
    if (participants.length === 0) { errorEl.textContent = "Select at least one participant."; return; }

    await db.collection("groups").doc(currentGroup.id).collection("expenses").add({
      description,
      amount: round2(amount),
      paidBy,
      participants,
      category: category || null,
      date,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    closeModals();
    showToast("Expense added.");
    await loadGroupData();
  });

  // ---------------- Balances ----------------

  function renderBalances() {
    const rowEl = document.getElementById("balances-row");
    rowEl.innerHTML = "";

    const members = currentGroup.memberIds.map((uid) => ({ uid, name: nameOf(uid) }));
    // Balances always reflect expenses AND every real settlement payment
    // recorded so far -- this is the actual current state, not a snapshot.
    const { balances } = computeSettlementPlan(members, currentExpenses, currentPayments);

    members.forEach((m) => {
      const bal = balances[m.uid] || 0;
      const cls = bal > 0.004 ? "positive" : bal < -0.004 ? "negative" : "zero";
      const label = bal > 0.004 ? "gets back" : bal < -0.004 ? "owes" : "settled";
      const chip = document.createElement("div");
      chip.className = "balance-chip";
      chip.innerHTML = `
        <div class="name">${escapeHtml(m.name)}</div>
        <div class="amount ${cls}">${rupee(Math.abs(bal))}</div>
        <div class="amount-label">${label}</div>
      `;
      rowEl.appendChild(chip);
    });
  }

  // ---------------- Settlements ----------------
  //
  // "Mark as Paid" records a REAL settlement-payment entry (from, to, amount,
  // timestamp) in groups/{groupId}/payments. It is never a status flag on a
  // computed transaction. Every balance and every settlement plan is always
  // recomputed fresh from (all expenses + all payments), so:
  //  - a full payment fully clears that debt going forward
  //  - a partial payment (editable amount, defaults to the suggested amount)
  //    leaves the remainder outstanding
  //  - a new expense added after a payment can correctly flip debt direction
  //    (e.g. Maheera -> Priya) instead of resurrecting the old amount
  //  - refreshing the page shows the same result, since it's derived from
  //    the stored ledger, not any client-side or session state

  function renderSettlementsView() {
    const members = currentGroup.memberIds.map((uid) => ({ uid, name: nameOf(uid) }));
    const { transactions } = computeSettlementPlan(members, currentExpenses, currentPayments);

    renderSettlementTransactions(transactions);
    renderPaymentHistory();
  }

  function renderSettlementTransactions(transactions) {
    const listEl = document.getElementById("settlements-list");
    const emptyEl = document.getElementById("settlements-empty");
    listEl.innerHTML = "";

    if (transactions.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");

    transactions.forEach((t, idx) => {
      const item = document.createElement("div");
      item.className = "list-item settlement-item";
      item.innerHTML = `
        <div class="settlement-flow">
          <span>${escapeHtml(nameOf(t.from))}</span>
          <span class="arrow">→</span>
          <span>${escapeHtml(nameOf(t.to))}</span>
        </div>
        <div class="settlement-pay-controls">
          <span class="settlement-suggested">Suggested: ${rupee(t.amount)}</span>
          <input type="number" class="pay-amount-input" min="0.01" step="0.01"
                 value="${t.amount}" data-idx="${idx}" />
          <button class="btn btn-primary btn-small" data-record-payment="${idx}"
                  data-from="${t.from}" data-to="${t.to}">Mark as Paid</button>
        </div>
      `;
      listEl.appendChild(item);
    });

    listEl.querySelectorAll("[data-record-payment]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = btn.dataset.recordPayment;
        const input = listEl.querySelector(`.pay-amount-input[data-idx="${idx}"]`);
        const amount = round2(parseFloat(input.value));
        const from = btn.dataset.from;
        const to = btn.dataset.to;

        if (!amount || amount <= 0) {
          showToast("Enter a valid payment amount.", true);
          return;
        }

        await db.collection("groups").doc(currentGroup.id).collection("payments").add({
          from,
          to,
          amount,
          groupId: currentGroup.id,
          timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });

        showToast(
          amount < parseFloat(input.getAttribute("value"))
            ? "Partial payment recorded."
            : "Payment recorded."
        );
        await loadGroupData();
      });
    });
  }

  function renderPaymentHistory() {
    const listEl = document.getElementById("payment-history-list");
    const emptyEl = document.getElementById("payment-history-empty");
    if (!listEl) return; // defensive, in case markup wasn't updated
    listEl.innerHTML = "";

    if (currentPayments.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");

    currentPayments.forEach((p) => {
      const when = p.timestamp && p.timestamp.toDate ? p.timestamp.toDate().toLocaleString() : "";
      const item = document.createElement("div");
      item.className = "list-item history-item";
      item.innerHTML = `
        <div class="li-main">
          <div class="li-title">${escapeHtml(nameOf(p.from))} → ${escapeHtml(nameOf(p.to))} · ${rupee(p.amount)}</div>
          <div class="li-sub">${escapeHtml(when)}</div>
        </div>
        <button class="btn btn-ghost btn-small" data-undo-payment="${p.id}">Undo</button>
      `;
      listEl.appendChild(item);
    });

    listEl.querySelectorAll("[data-undo-payment]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.undoPayment;
        await db.collection("groups").doc(currentGroup.id).collection("payments").doc(id).delete();
        showToast("Payment record removed.");
        await loadGroupData();
      });
    });
  }

  // ---------------- Utilities ----------------

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  return {
    async init(loggedInUser) {
      user = loggedInUser;
      goToDashboard();
    }
  };
})();
