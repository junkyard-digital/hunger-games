// Creates a gamemaker account from a username + password (no email needed).
// Optional secret GM_SIGNUP_CODE: when set, signups must provide it.
import { admin, cors, json } from "../_shared/admin.ts";

export const GM_EMAIL_DOMAIN = "gamemakers.hunger-games.local";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const { username, password, signupCode } = await req.json().catch(() => ({}));
  const name = String(username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(name)) {
    return json({ error: "Username must be 3-24 letters, numbers, or underscores" }, 400);
  }
  if (typeof password !== "string" || password.length < 8) {
    return json({ error: "Password must be at least 8 characters" }, 400);
  }
  const requiredCode = Deno.env.get("GM_SIGNUP_CODE");
  if (requiredCode && signupCode !== requiredCode) return json({ error: "Invalid signup code" }, 403);

  const { data: taken } = await admin.from("gamemaker_profiles").select("user_id").eq("username", name).maybeSingle();
  if (taken) return json({ error: "That username is taken" }, 409);

  const { data, error } = await admin.auth.admin.createUser({
    email: `${name}@${GM_EMAIL_DOMAIN}`,
    password,
    email_confirm: true,
    user_metadata: { username: name },
  });
  if (error) return json({ error: error.message }, 400);

  const { error: profileError } = await admin.from("gamemaker_profiles").insert({ user_id: data.user.id, username: name });
  if (profileError) {
    await admin.auth.admin.deleteUser(data.user.id);
    return json({ error: "That username is taken" }, 409);
  }
  return json({ ok: true });
});
