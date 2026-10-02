// Accounts on the page: session state, the API helper (CSRF token on every
// signed-in request), the account panel above the toolbar and the account
// dialog (sign up, sign in, forgot / reset password, edit name).
// game.js reads window.SnakeAccount.state and listens with onChange().
(() => {
  const PING_KEY = "snakearcade.account-ping";
  const listeners = [];
  const state = { status: "loading", user: null };
  let csrfToken = "";
  let locked = false;
  let resetToken = "";

  // ---------- API
  let freshSeq = 0;
  function freshUrl(path) {
    freshSeq += 1;
    return `${path}${path.includes("?") ? "&" : "?"}_=${Date.now().toString(36)}.${freshSeq}`;
  }

  async function parse(response) {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch (_) {
      return {};
    }
  }

  // Resolves { ok, status, data }; never throws (status 0 = network error).
  async function api(method, path, body, { retried = false } = {}) {
    const headers = {};
    const init = { method, headers, cache: "no-store", credentials: "same-origin" };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      if (csrfToken) {
        headers["X-CSRF-Token"] = csrfToken;
      }
      init.body = JSON.stringify(body || {});
    }
    let response;
    try {
      response = await fetch(method === "GET" ? freshUrl(path) : path, init);
    } catch (_) {
      return { ok: false, status: 0, data: { error: "network", message: "Network error. Check your connection and try again." } };
    }
    const data = await parse(response);
    if (response.status === 403 && data.error === "csrf_failed" && !retried) {
      // Token out of date (server restarted, or signed in in another tab):
      // pick up the current session and try once more.
      await refresh();
      return api(method, path, body, { retried: true });
    }
    if (response.status === 401 && data.error === "signed_out" && state.status !== "signedOut") {
      setSignedOut();
    }
    return { ok: response.ok && data.ok !== false, status: response.status, data };
  }

  // ---------- state
  function emit(reason) {
    renderPanel();
    listeners.forEach((fn) => {
      try {
        fn(state, reason);
      } catch (err) {
        console.error(err);
      }
    });
  }

  function applyMe(data, reason = "refresh") {
    if (data && data.signedIn && data.user) {
      csrfToken = data.csrfToken || csrfToken;
      state.user = { ...data.user };
      state.status = data.user.verified ? "verified" : "unverified";
    } else {
      csrfToken = "";
      state.user = null;
      state.status = "signedOut";
    }
    emit(reason);
  }

  function setSignedOut() {
    applyMe(null, "signedOut");
  }

  async function refresh() {
    const res = await api("GET", "/api/auth/me");
    if (res.status === 0) {
      if (state.status === "loading") {
        state.status = "offline";
        emit("offline");
      }
      return state;
    }
    applyMe(res.data, "refresh");
    return state;
  }

  // Tell other tabs of this browser to re-read the session.
  function ping() {
    try {
      localStorage.setItem(PING_KEY, String(Date.now()));
    } catch (_) {
      /* storage blocked */
    }
  }
  window.addEventListener("storage", (event) => {
    if (event.key === PING_KEY) {
      refresh();
    }
  });
  // Back from the mail app after confirming: check again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.status === "unverified") {
      refresh();
    }
  });

  // Score fields from a save / reset answer, so the account stays in step.
  function patchUser(patch) {
    if (!state.user) {
      return;
    }
    state.user = { ...state.user, ...patch };
    emit("patch");
  }

  // ---------- account panel
  const panel = document.querySelector("#account-panel");
  const nameEl = document.querySelector("#account-name");
  const badgeEl = document.querySelector("#account-badge");
  const hintEl = document.querySelector("#account-hint");
  const btnSignup = document.querySelector("#account-signup");
  const btnSignin = document.querySelector("#account-signin");
  const btnResend = document.querySelector("#account-resend");
  const btnEdit = document.querySelector("#account-edit-name");
  const btnSignout = document.querySelector("#account-signout");
  let panelNote = null;

  function maskedEmail() {
    const email = state.user && state.user.email ? state.user.email : "";
    const at = email.indexOf("@");
    return at > 0 ? `${email.slice(0, 1)}•••${email.slice(at)}` : "your inbox";
  }

  function renderPanel() {
    const s = state.status;
    panel.dataset.state = s;
    const show = (el, on) => {
      el.hidden = !on;
    };
    show(btnSignup, s === "signedOut" || s === "offline");
    show(btnSignin, s === "signedOut" || s === "offline");
    show(btnResend, s === "unverified");
    show(btnEdit, s === "verified" || s === "unverified");
    show(btnSignout, s === "verified" || s === "unverified");
    btnEdit.disabled = locked;
    btnSignout.disabled = locked;
    btnEdit.title = locked ? "End this game to change your name" : "";
    btnSignout.title = locked ? "End this game to sign out" : "";
    badgeEl.hidden = s !== "unverified";
    let tone = "";
    let hint;
    if (s === "loading") {
      nameEl.textContent = "Checking…";
      hint = "Checking your account…";
    } else if (s === "offline") {
      nameEl.textContent = "Offline";
      hint = "Couldn’t reach the server. Check your connection, then reload.";
      tone = "error";
    } else if (s === "signedOut") {
      nameEl.textContent = "Not signed in";
      hint = "Sign up (free) or sign in to play and post scores to the arcade board.";
    } else if (s === "unverified") {
      nameEl.textContent = state.user.displayName;
      hint = `Confirm your email to play: open the link we sent to ${maskedEmail()}. No email? Check spam, or Resend email.`;
    } else {
      nameEl.textContent = state.user.displayName;
      hint = locked ? "Signed in. Your best score is saved to your account." : "Signed in. Your best score is saved to your account. Start when ready.";
    }
    if (panelNote) {
      hint = panelNote.text;
      tone = panelNote.tone;
    }
    hintEl.textContent = hint;
    hintEl.classList.toggle("error", tone === "error");
    hintEl.classList.toggle("ok", tone === "ok");
  }

  function note(text, tone = "", ms = 8000) {
    panelNote = text ? { text, tone } : null;
    renderPanel();
    if (text && ms) {
      const mine = panelNote;
      setTimeout(() => {
        if (panelNote === mine) {
          panelNote = null;
          renderPanel();
        }
      }, ms);
    }
  }

  btnSignup.addEventListener("click", () => openDialog("signup"));
  btnSignin.addEventListener("click", () => openDialog("signin"));
  btnEdit.addEventListener("click", () => {
    if (!locked) {
      openDialog("name");
    }
  });
  btnResend.addEventListener("click", async () => {
    btnResend.disabled = true;
    const res = await api("POST", "/api/auth/resend-verification", {});
    btnResend.disabled = false;
    if (res.ok && res.data.alreadyVerified) {
      await refresh();
      note("Your email is already confirmed.", "ok");
    } else if (res.ok) {
      note(`Sent a new link to ${maskedEmail()}. It works once and expires in 24 hours.`, "ok");
    } else {
      note(res.data.message || "Couldn’t send the email.", "error");
    }
    announce(hintEl.textContent);
  });
  btnSignout.addEventListener("click", async () => {
    if (locked) {
      return;
    }
    btnSignout.disabled = true;
    const res = await api("POST", "/api/auth/logout", {});
    btnSignout.disabled = false;
    if (!res.ok) {
      // Includes network errors (status 0): the request may never have reached
      // the server, so the session cookie is still valid. Keep showing the
      // signed-in state rather than claiming a sign-out a reload would undo.
      note(
        res.status === 0 ? "Couldn’t reach the server, so you’re still signed in. Check your connection and try again." : res.data.message || "Couldn’t sign out.",
        "error"
      );
      return;
    }
    setSignedOut();
    ping();
    note("Signed out.", "ok", 4000);
    announce("Signed out.");
    btnSignin.focus({ preventScroll: true });
  });

  // ---------- dialog
  const backdrop = document.querySelector("#account-backdrop");
  const dialog = document.querySelector("#account-dialog");
  const titleEl = document.querySelector("#account-title");
  const views = {
    signup: { form: document.querySelector("#form-signup"), title: "Create your account" },
    signin: { form: document.querySelector("#form-signin"), title: "Sign in" },
    forgot: { form: document.querySelector("#form-forgot"), title: "Forgot password" },
    reset: { form: document.querySelector("#form-reset"), title: "Choose a new password" },
    name: { form: document.querySelector("#form-name"), title: "Edit display name" },
    message: { form: document.querySelector("#form-message"), title: "SnakeArcade" }
  };
  const statusEl = document.querySelector("#status");
  let currentView = null;
  let returnFocus = null;

  function announce(text) {
    if (statusEl) {
      statusEl.textContent = "";
      statusEl.textContent = text;
    }
  }

  function isDialogOpen() {
    return !backdrop.hidden;
  }

  function formMsg(form, text, tone = "error") {
    const el = form.querySelector(".form-msg");
    el.textContent = text || "";
    el.dataset.tone = text ? tone : "";
  }

  function clearInvalid(form) {
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  }

  function markInvalid(form, field) {
    const input = field ? form.querySelector(`[data-field="${field}"]`) : null;
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.focus({ preventScroll: true });
    }
  }

  function showView(name, { message = "", tone = "", title = "" } = {}) {
    Object.entries(views).forEach(([key, v]) => {
      v.form.hidden = key !== name;
    });
    currentView = name;
    const view = views[name];
    titleEl.textContent = title || view.title;
    clearInvalid(view.form);
    formMsg(view.form, message, tone || "error");
    view.form.querySelectorAll("button").forEach((b) => {
      b.disabled = false;
    });
    if (name === "name" && state.user) {
      view.form.querySelector("#name-input").value = state.user.displayName;
    }
    if (name === "message") {
      document.querySelector("#message-text").textContent = message;
      formMsg(view.form, "");
    }
    const first = view.form.querySelector("input:not([type=hidden]):not([type=checkbox]), button[type=submit]");
    if (first) {
      first.focus({ preventScroll: true });
      if (name === "name" && first.select) {
        first.select();
      }
    }
  }

  function openDialog(name, opts) {
    if (!isDialogOpen()) {
      returnFocus = document.activeElement;
      backdrop.hidden = false;
      document.querySelector(".shell").inert = true;
      document.documentElement.classList.add("modal-open");
      listeners.forEach((fn) => fn(state, "dialogOpen"));
    }
    showView(name, opts);
  }

  function closeDialog() {
    if (!isDialogOpen()) {
      return;
    }
    backdrop.hidden = true;
    document.querySelector(".shell").inert = false;
    document.documentElement.classList.remove("modal-open");
    Object.values(views).forEach((v) => {
      v.form.querySelectorAll("input[type=password]").forEach((i) => {
        i.value = "";
        i.type = "password";
      });
      v.form.querySelectorAll(".show-password input").forEach((c) => {
        c.checked = false;
      });
    });
    resetToken = "";
    currentView = null;
    const fallback = [btnSignin, btnEdit, btnSignup].find((b) => !b.hidden && b.getClientRects().length) || document.querySelector("#game");
    const back = returnFocus && returnFocus.isConnected && returnFocus.getClientRects().length && !returnFocus.disabled ? returnFocus : fallback;
    returnFocus = null;
    back.focus({ preventScroll: true });
    listeners.forEach((fn) => fn(state, "dialogClose"));
  }

  function dialogFocusables() {
    return Array.from(dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])")).filter(
      (el) => el.getClientRects().length > 0
    );
  }

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const items = dialogFocusables();
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closeDialog();
    }
  });
  document.addEventListener("focusin", (event) => {
    if (isDialogOpen() && !dialog.contains(event.target)) {
      const items = dialogFocusables();
      if (items.length) {
        items[0].focus({ preventScroll: true });
      }
    }
  });
  dialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeDialog));
  dialog.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", (event) => {
      event.preventDefault();
      const target = b.dataset.view;
      // Carry the typed email across sign in / sign up / forgot.
      const from = currentView && views[currentView].form.querySelector("input[type=email]");
      showView(target);
      const to = views[target].form.querySelector("input[type=email]");
      if (from && to && from.value && !to.value) {
        to.value = from.value;
      }
    })
  );
  dialog.querySelectorAll(".show-password input").forEach((box) =>
    box.addEventListener("change", () => {
      box.closest("form").querySelectorAll("input[data-password]").forEach((i) => {
        i.type = box.checked ? "text" : "password";
      });
    })
  );

  function values(form) {
    const out = {};
    form.querySelectorAll("input[data-field]").forEach((i) => {
      out[i.dataset.field] = i.value;
    });
    return out;
  }

  function busy(form, on) {
    form.querySelectorAll("button").forEach((b) => {
      b.disabled = on;
    });
    form.setAttribute("aria-busy", on ? "true" : "false");
  }

  function failForm(form, res) {
    const d = res.data || {};
    formMsg(form, d.message || `Something went wrong (HTTP ${res.status}).`);
    markInvalid(form, d.field);
    announce(d.message || "Something went wrong.");
  }

  function requireFields(form, list) {
    clearInvalid(form);
    for (const [field, label] of list) {
      const input = form.querySelector(`[data-field="${field}"]`);
      if (!input.value.trim()) {
        formMsg(form, `Enter your ${label}.`);
        markInvalid(form, field);
        return false;
      }
    }
    return true;
  }

  views.signup.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = views.signup.form;
    if (!requireFields(form, [["email", "email"], ["displayName", "display name"], ["password", "password"]])) {
      return;
    }
    busy(form, true);
    formMsg(form, "Creating your account…", "pending");
    const res = await api("POST", "/api/auth/signup", values(form));
    busy(form, false);
    if (!res.ok) {
      failForm(form, res);
      return;
    }
    applyMe(res.data, "signup");
    ping();
    const mail = res.data.mailSent === false
      ? "Your account is ready, but the confirmation email couldn’t be sent just now. Use Resend email in a minute."
      : `Almost there! We sent a confirmation link to ${maskedEmail()}. Open it to start playing. It expires in 24 hours.`;
    showView("message", { message: mail, title: "Check your email" });
    announce(mail);
  });

  views.signin.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = views.signin.form;
    if (!requireFields(form, [["email", "email"], ["password", "password"]])) {
      return;
    }
    busy(form, true);
    formMsg(form, "Signing in…", "pending");
    const res = await api("POST", "/api/auth/login", values(form));
    busy(form, false);
    if (!res.ok) {
      failForm(form, res);
      form.querySelector("[data-field=password]").value = "";
      return;
    }
    applyMe(res.data, "signin");
    ping();
    closeDialog();
    const text = state.status === "verified" ? `Signed in as ${state.user.displayName}.` : `Signed in as ${state.user.displayName}. Confirm your email to play.`;
    note(text, "ok", 5000);
    announce(text);
  });

  views.forgot.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = views.forgot.form;
    if (!requireFields(form, [["email", "email"]])) {
      return;
    }
    busy(form, true);
    formMsg(form, "Sending…", "pending");
    const res = await api("POST", "/api/auth/forgot", values(form));
    busy(form, false);
    if (!res.ok) {
      failForm(form, res);
      return;
    }
    showView("message", { message: res.data.message, title: "Check your email" });
    announce(res.data.message);
  });

  views.reset.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = views.reset.form;
    if (!requireFields(form, [["password", "new password"]])) {
      return;
    }
    busy(form, true);
    formMsg(form, "Changing your password…", "pending");
    const res = await api("POST", "/api/auth/reset", { token: resetToken, password: values(form).password });
    busy(form, false);
    if (!res.ok) {
      failForm(form, res);
      return;
    }
    resetToken = "";
    applyMe(res.data, "reset");
    ping();
    showView("message", { message: `Password changed. You’re signed in as ${state.user.displayName}, and signed out everywhere else.`, title: "All set" });
  });

  views.name.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = views.name.form;
    if (locked) {
      formMsg(form, "End this game to change your name.");
      return;
    }
    if (!requireFields(form, [["displayName", "display name"]])) {
      return;
    }
    busy(form, true);
    formMsg(form, "Saving…", "pending");
    const res = await api("POST", "/api/account/name", values(form));
    busy(form, false);
    if (!res.ok) {
      failForm(form, res);
      return;
    }
    applyMe(res.data, "rename");
    listeners.forEach((fn) => fn(state, "board", res.data));
    closeDialog();
    note(`Name changed to ${state.user.displayName}. Your best stays with your account.`, "ok", 5000);
    announce(`Name changed to ${state.user.displayName}.`);
  });

  views.message.form.addEventListener("submit", (event) => {
    event.preventDefault();
    closeDialog();
  });

  // ---------- links from emails: /?verify=TOKEN and /?reset=TOKEN. The token
  // is POSTed from here (a GET alone never uses it), then removed from the URL.
  function takeParam(name) {
    const url = new URL(window.location.href);
    const value = url.searchParams.get(name);
    if (value) {
      url.searchParams.delete(name);
      window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
    }
    return value;
  }

  async function handleLinks() {
    const verify = takeParam("verify");
    const reset = takeParam("reset");
    if (verify) {
      const res = await api("POST", "/api/auth/verify", { token: verify });
      if (res.ok && res.data.signedIn && res.data.user) {
        applyMe(res.data, "verified");
        ping();
        openDialog("message", { title: "Email confirmed", message: `Thanks, ${state.user.displayName}! Your email is confirmed. Press Start to play.` });
      } else if (res.ok) {
        ping();
        await refresh();
        if (state.status === "signedOut") {
          openDialog("signin", { message: "Email confirmed. Sign in to play.", tone: "ok" });
        } else {
          openDialog("message", { title: "Email confirmed", message: "That account’s email is confirmed. It can sign in and play now." });
        }
      } else {
        openDialog("message", { title: "Link didn’t work", message: res.data.message || "This confirmation link isn’t valid." });
      }
    } else if (reset) {
      resetToken = reset;
      openDialog("reset");
    }
  }

  async function init() {
    await refresh();
    await handleLinks();
  }

  window.SnakeAccount = {
    state,
    api,
    refresh,
    patchUser,
    onChange: (fn) => listeners.push(fn),
    isDialogOpen,
    openDialog,
    closeDialog,
    setLocked(on) {
      locked = Boolean(on);
      renderPanel();
    },
    ready: null
  };
  renderPanel();
  window.SnakeAccount.ready = init();
})();
