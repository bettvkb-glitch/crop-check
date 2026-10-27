import { supabase } from "./supabase.js";

// ---- Supabase Auth calls ----
export const signIn = (email, password) => supabase.auth.signInWithPassword({ email, password });
export const signUp = (email, password, name) =>
  supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: location.origin, data: name ? { full_name: name } : {} },
  });
export const signOut = () => supabase.auth.signOut();
export const sendReset = (email) => supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
export const setNewPassword = (password) => supabase.auth.updateUser({ password });

export function displayName(user) {
  return user?.user_metadata?.full_name || (user?.email || "Farmer").split("@")[0];
}

/** Turn Supabase error text into something a farmer can act on. */
export function friendlyError(err) {
  const m = (err?.message || "").toLowerCase();
  if (m.includes("invalid login")) return "Email or password is wrong. Check both and try again.";
  if (m.includes("not confirmed")) return "Confirm your email first. We sent you a link.";
  if (m.includes("already registered")) return "This email already has an account. Sign in instead.";
  if (m.includes("password") && m.includes("least")) return "Use a password with at least 8 characters.";
  if (m.includes("rate limit") || m.includes("too many")) return "Too many tries. Wait a minute, then try again.";
  if (m.includes("failed to fetch") || m.includes("network")) return "No connection. Check your signal and try again.";
  return "Something went wrong. Try again.";
}

// ---- Auth form controller (sign in / register / reset / new password) ----
const MODES = {
  signin: { title: "Welcome back", submit: "Sign In", sub: "Sign in to scan leaves and see outbreaks near you.", pass: "🔒 Password", ac: "current-password", name: false, email: true, password: true, tabs: true, forgot: true, home: true },
  signup: { title: "Create your account", submit: "Create Account", sub: "Free to use. No card needed.", pass: "🔒 Password (8+ characters)", ac: "new-password", name: true, email: true, password: true, tabs: true, home: true },
  reset: { title: "Reset your password", submit: "Send Reset Link", sub: "We'll email you a link to set a new password.", name: false, email: true, password: false, tabs: false, back: true },
  recovery: { title: "Choose a new password", submit: "Save New Password", sub: "Pick something you'll remember.", pass: "🔒 New password (8+ characters)", ac: "new-password", name: false, email: false, password: true, tabs: false },
};

export function initAuthUI({ onPasswordUpdated }) {
  const $ = (id) => document.getElementById(id);
  const f = { email: $("email"), name: $("name"), pass: $("password"), passLabel: $("pass-label"), submit: $("auth-submit"), msg: $("auth-msg"), sub: $("auth-sub"), title: $("auth-title"), seg: $("seg"), forgot: $("forgot"), back: $("back"), home: $("auth-home"), toggle: $("pw-toggle"), form: $("auth-form") };
  let mode = "signin";

  function message(text, ok = false) {
    f.msg.hidden = !text;
    f.msg.textContent = text || "";
    f.msg.classList.toggle("ok", ok);
    f.msg.setAttribute("role", ok ? "status" : "alert");
  }

  function setMode(next, keepMessage = false) {
    mode = next;
    const m = MODES[next];
    f.title.textContent = m.title;
    f.sub.textContent = m.sub;
    f.submit.textContent = m.submit;
    f.seg.hidden = !m.tabs;
    $("f-name").hidden = !m.name;
    $("f-email").hidden = !m.email;
    $("f-pass").hidden = !m.password;
    if (m.password) { f.passLabel.textContent = m.pass; f.pass.autocomplete = m.ac; }
    f.forgot.hidden = !m.forgot;
    f.back.hidden = !m.back;
    f.home.hidden = !m.home;
    $("tab-signin").setAttribute("aria-selected", String(next === "signin"));
    $("tab-signup").setAttribute("aria-selected", String(next === "signup"));
    f.pass.type = "password"; f.toggle.textContent = "Show"; f.toggle.setAttribute("aria-pressed", "false");
    f.pass.value = "";
    if (!keepMessage) message();
  }

  f.seg.addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) setMode(b.dataset.mode); });
  f.forgot.addEventListener("click", () => setMode("reset"));
  f.back.addEventListener("click", () => setMode("signin"));
  f.toggle.addEventListener("click", () => {
    const show = f.pass.type === "password";
    f.pass.type = show ? "text" : "password";
    f.toggle.textContent = show ? "Hide" : "Show";
    f.toggle.setAttribute("aria-pressed", String(show));
  });

  f.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const m = MODES[mode];
    const email = f.email.value.trim();
    const password = f.pass.value;
    if (m.email && !/^\S+@\S+\.\S+$/.test(email)) return message("Enter a valid email address.");
    if (m.password && mode !== "signin" && password.length < 8) return message("Use a password with at least 8 characters.");
    if (mode === "signin" && !password) return message("Enter your password.");

    f.submit.disabled = true;
    message();
    try {
      if (mode === "signin") {
        const { error } = await signIn(email, password);
        if (error) message(friendlyError(error)); // success: onAuthStateChange opens the dashboard
      } else if (mode === "signup") {
        const { data, error } = await signUp(email, password, f.name.value.trim());
        if (error) return message(friendlyError(error));
        if (data.user && data.user.identities && data.user.identities.length === 0) {
          message("This email already has an account. Sign in instead.");
        } else if (!data.session) {
          setMode("signin");
          message("Check your email and confirm your account, then sign in.", true);
        } // else: session exists, listener opens the dashboard
      } else if (mode === "reset") {
        const { error } = await sendReset(email);
        if (error) return message(friendlyError(error));
        setMode("signin");
        message("If that email has an account, a reset link is on its way.", true);
      } else if (mode === "recovery") {
        const { error } = await setNewPassword(password);
        if (error) return message(friendlyError(error));
        onPasswordUpdated();
      }
    } catch (err) {
      message(friendlyError(err));
    } finally {
      f.submit.disabled = false;
    }
  });

  setMode("signin");
  return { setMode, getMode: () => mode };
}
