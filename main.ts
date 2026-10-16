// The Crimson feedback relay, on Deno Deploy (free, always online). Players' launchers POST their feedback to
// /feedback; every message is kept in Deno KV for good, so nothing is lost while the owner's PC is off. The owner's
// Crimson Inbox app reads them from /inbox with the owner key (only its SHA-256 is written here, so this file can be
// public). Optional: DISCORD_WEBHOOK in the app's environment variables also posts each message to a Discord channel.

const OWNER_KEY_SHA256 = "454fbfe169d802409f845b449be9906baf54be6bec261e72528d03a2ad97db6e";
const PER_HOUR = 5;                      // messages one address may send in an hour
const kv = await Deno.openKv();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** True when this address has already sent its share this hour (the count expires with the hour). */
async function overLimit(address: string): Promise<boolean> {
  const key = ["rate", address, Math.floor(Date.now() / 3_600_000)];
  const sent = (await kv.get<number>(key)).value ?? 0;
  if (sent >= PER_HOUR) return true;
  await kv.set(key, sent + 1, { expireIn: 3_600_000 });
  return false;
}

async function receive(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send JSON." }, 400);
  }
  const text = clean(body.text, 1500);
  if (text.length < 3) return json({ error: "Write a few words first." }, 400);
  const address = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    (info.remoteAddr as Deno.NetAddr).hostname;
  if (await overLimit(address)) return json({ error: "Thanks! Wait a little before sending another." }, 429);

  const category = ["bug", "idea", "other"].includes(String(body.category)) ? String(body.category) : "other";
  const message = {
    // time first, so the ids sort in the order the messages came in
    id: `${String(Date.now()).padStart(15, "0")}-${crypto.randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
    stars: Math.max(0, Math.min(5, Math.round(Number(body.stars) || 0))),
    category,
    text,
    name: clean(body.name, 32) || null,
    launcher: clean(body.launcher, 32),
    os: clean(body.os, 80),
  };
  await kv.set(["msg", message.id], message);

  const hook = Deno.env.get("DISCORD_WEBHOOK");
  if (hook) {
    const stars = message.stars ? " " + "★".repeat(message.stars) + "☆".repeat(5 - message.stars) : "";
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `**${message.category}**${stars}\n${message.text}\n— ${message.name ?? "anonymous"} · launcher ${message.launcher}`,
        allowed_mentions: { parse: [] },
      }),
    }).catch(() => {});
  }
  return json({ ok: true });
}

/** The owner's inbox: every message after the given id, oldest first (500 at a time). */
async function inbox(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key || (await sha256Hex(key)) !== OWNER_KEY_SHA256) return json({ error: "Not yours." }, 401);
  const after = new URL(req.url).searchParams.get("after") ?? "";
  const messages = [];
  const selector = after ? { prefix: ["msg"], start: ["msg", after + "\u0000"] } : { prefix: ["msg"] };
  for await (const entry of kv.list(selector, { limit: 500 })) messages.push(entry.value);
  return json({ messages });
}

Deno.serve(async (req, info) => {
  const path = new URL(req.url).pathname;
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" },
    });
  }
  if (path === "/feedback" && req.method === "POST") return await receive(req, info);
  if (path === "/inbox" && req.method === "GET") return await inbox(req);
  if (path === "/") return json({ name: "Crimson feedback relay", ok: true });
  return json({ error: "Not found." }, 404);
});
