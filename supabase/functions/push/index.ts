// Delivers Web Push notifications. Needs no secrets:
//  GET  → makes sure VAPID keys exist (generating them once) and returns the public key.
//  POST {id} → called by the database trigger for each new notification row.
import webpush from "npm:web-push@3.6.7";
import { admin, cors, json } from "../_shared/admin.ts";

async function vapidKeys() {
  const { data } = await admin.from("app_secrets").select("key, value")
    .in("key", ["vapid_public_key", "vapid_private_key"]);
  const found = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  if (found.vapid_public_key && found.vapid_private_key) {
    return { publicKey: found.vapid_public_key, privateKey: found.vapid_private_key };
  }
  const keys = webpush.generateVAPIDKeys();
  // ignoreDuplicates: if two cold starts race, the first writer wins and we re-read.
  await admin.from("app_secrets").upsert([
    { key: "vapid_public_key", value: keys.publicKey },
    { key: "vapid_private_key", value: keys.privateKey },
  ], { onConflict: "key", ignoreDuplicates: true });
  return vapidKeys();
}

async function registerUrl() {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/push`;
  await admin.from("app_secrets").upsert({ key: "push_function_url", value: url }, { onConflict: "key" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const keys = await vapidKeys();
  if (req.method === "GET") {
    await registerUrl();
    return json({ publicKey: keys.publicKey });
  }

  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== "number") return json({ error: "id required" }, 400);

  // push_claim only returns a payload once per notification, so replaying ids is harmless.
  const { data: payload, error } = await admin.rpc("push_claim", { p_id: id });
  if (error) return json({ error: error.message }, 500);
  if (!payload) return json({ skipped: true });

  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:gamemaker@example.com", keys.publicKey, keys.privateKey);
  const message = JSON.stringify({ title: payload.title, body: payload.body, kind: payload.kind, gameId: payload.game_id });

  const results = await Promise.allSettled(payload.subscriptions.map(async (sub: webpush.PushSubscription) => {
    try {
      await webpush.sendNotification(sub, message, { TTL: 120, urgency: "high" });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await admin.rpc("remove_push_subscription", { p_endpoint: sub.endpoint });
      throw err;
    }
  }));
  return json({ sent: results.filter((r) => r.status === "fulfilled").length, total: results.length });
});
