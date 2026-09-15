// ------------------------------------------------------------------
// Authentication
// ------------------------------------------------------------------

let currentUser = null; // { uid, name, email }

function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function showView(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(viewId).classList.add("active");
}

// ---- Auth tab switching (login / signup) ----
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const which = tab.dataset.authTab;
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("login-form").classList.toggle("hidden", which !== "login");
    document.getElementById("signup-form").classList.toggle("hidden", which !== "signup");
  });
});

document.querySelectorAll("[data-show-auth]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const which = btn.dataset.showAuth;
    document.querySelector(`.auth-tab[data-auth-tab="${which}"]`).click();
    showView("view-auth");
  });
});

// ---- Sign up ----
document.getElementById("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;
  const errorEl = document.getElementById("signup-error");
  errorEl.textContent = "";

  if (!name) {
    errorEl.textContent = "Please enter your name.";
    return;
  }

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await db.collection("users").doc(cred.user.uid).set({
      name,
      email: email.toLowerCase(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    // onAuthStateChanged will take it from here
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err);
  }
});

// ---- Log in ----
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err);
  }
});

// ---- Log out ----
document.getElementById("logout-btn").addEventListener("click", async () => {
  await auth.signOut();
});

function friendlyAuthError(err) {
  const map = {
    "auth/email-already-in-use": "That email is already registered. Try logging in instead.",
    "auth/invalid-email": "That doesn't look like a valid email address.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password."
  };
  return map[err.code] || err.message;
}

// ---- Auth state listener: the single source of truth for what's shown ----
auth.onAuthStateChanged(async (user) => {
  const navbar = document.getElementById("navbar");

  if (!user) {
    currentUser = null;
    navbar.classList.add("hidden");
    showView("view-landing");
    return;
  }

  const userDoc = await db.collection("users").doc(user.uid).get();
  const profile = userDoc.exists ? userDoc.data() : { name: user.email, email: user.email };

  currentUser = { uid: user.uid, name: profile.name, email: profile.email };

  navbar.classList.remove("hidden");
  document.getElementById("nav-user-name").textContent = currentUser.name;

  // Hand off to app.js to load the dashboard
  await App.init(currentUser);
});
