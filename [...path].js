// One Vercel serverless function that handles every /api/... route used by app.js.
// Database: Neon (DATABASE_URL is added automatically by the Vercel + Neon integration).
const { neon } = require("@neondatabase/serverless");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sql = DB_URL ? neon(DB_URL) : null;
const q = (text, params = []) => sql.query(text, params);

// Set JWT_SECRET in Vercel (any long random text). Falls back to a value derived from DATABASE_URL.
const SECRET =
  process.env.JWT_SECRET ||
  crypto.createHash("sha256").update("nglmb:" + (DB_URL || "dev")).digest("hex");
const TOKEN_DAYS = 7;
const DUMMY_HASH = "$2b$10$XH7o19SQFxtIx0J2q1ovaOKTlIT.gLbjzUN/QXJpSA1d4LPoZqmmG";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

/* ---------- Tokens ---------- */
const b64 = (s) => Buffer.from(s).toString("base64url");
function sign(payload) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_DAYS * 864e5 }));
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verify(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}
const fingerprint = (hash) => crypto.createHash("sha256").update(hash).digest("hex").slice(0, 16);

/* ---------- Helpers ---------- */
const now = () => Math.floor(Date.now() / 1000);
const nowMs = () => Date.now();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 190;
const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 45);

async function currentAdmin(req) {
  const auth = String(req.headers.authorization || "");
  const p = auth.startsWith("Bearer ") ? verify(auth.slice(7)) : null;
  if (!p || p.t !== "a") return null;
  const rows = await q("SELECT id, email, name, ngl_link FROM admins WHERE id = $1", [p.id]);
  if (!rows[0]) return null;
  const a = rows[0];
  return { id: Number(a.id), email: a.email, name: a.name, ngl: a.ngl_link || "" };
}
async function needAdmin(req) {
  const a = await currentAdmin(req);
  if (!a) fail(401, "Log in as admin first.");
  return a;
}
async function currentMember(req) {
  const p = verify(String(req.headers["x-member-token"] || ""));
  if (!p || p.t !== "m") return null;
  const rows = await q("SELECT id, email, name, password_hash FROM members WHERE id = $1", [p.id]);
  const m = rows[0];
  if (!m || fingerprint(m.password_hash) !== p.h) return null;
  return { id: Number(m.id), email: m.email, name: m.name };
}

async function checkAttempts(ip, label) {
  await q("DELETE FROM login_attempts WHERE created_at < $1", [now() - 900]);
  const r = await q("SELECT COUNT(*)::int AS n FROM login_attempts WHERE ip = $1", [ip]);
  if (r[0].n >= 10) fail(429, `Too many ${label} attempts. Wait 15 minutes and try again.`);
}
const addAttempt = (ip) => q("INSERT INTO login_attempts (ip, created_at) VALUES ($1,$2)", [ip, now()]);
const clearAttempts = (ip) => q("DELETE FROM login_attempts WHERE ip = $1", [ip]);

const MIME_BY_TYPE = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
function looksLikeImage(buf, type) {
  if (type === "jpeg") return buf[0] === 0xff && buf[1] === 0xd8;
  if (type === "png") return buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (type === "gif") return buf.slice(0, 3).toString() === "GIF";
  if (type === "webp") return buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  return false;
}
// Saves a data-URL image in the photos table and returns its public path.
async function savePhoto(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = typeof value === "string" && /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  const bad = "Choose a valid JPG, PNG, GIF, or WebP image under 3 MB.";
  if (!m) fail(400, bad);
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > 3 * 1024 * 1024) fail(400, bad);
  if (!looksLikeImage(buf, m[1])) fail(400, "The selected file is not a valid supported image.");
  const r = await q("INSERT INTO photos (mime, data, created_at) VALUES ($1,$2,$3) RETURNING id", [
    MIME_BY_TYPE[m[1]], m[2], nowMs(),
  ]);
  return "/api/photos/" + r[0].id;
}
async function removePhoto(path) {
  const m = typeof path === "string" && /^\/api\/photos\/(\d+)$/.exec(path);
  if (m) await q("DELETE FROM photos WHERE id = $1", [Number(m[1])]);
}

/* ---------- Handler ---------- */
module.exports = async function handler(req, res) {
  const send = (status, data) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(status).send(JSON.stringify(data));
  };

  try {
    if (!sql) fail(500, "Database is not connected. Add DATABASE_URL in Vercel and redeploy.");

    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method;
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body && typeof body === "object" ? body : {};
    const voter = String(req.headers["x-voter"] || "");
    const voterOk = /^[A-Za-z0-9-]{16,64}$/.test(voter);
    const [a, b, c] = parts;
    const idNum = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

    /* ----- Public: settings ----- */
    if (a === "settings" && !b && method === "GET") {
      const rows = await q("SELECT name, ngl_link AS ngl FROM admins ORDER BY id");
      const links = rows.filter((r) => r.ngl);
      return send(200, { ngl: links[0]?.ngl || "", admins: links });
    }

    /* ----- Photos (binary) ----- */
    if (a === "photos" && b && method === "GET") {
      const rows = await q("SELECT mime, data FROM photos WHERE id = $1", [idNum(b)]);
      if (!rows[0]) return send(404, { error: "Not found." });
      res.setHeader("Content-Type", rows[0].mime);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(Buffer.from(rows[0].data, "base64"));
    }

    /* ----- Posts ----- */
    if (a === "posts" && !b && method === "GET") {
      const posts = await q(
        "SELECT p.id, p.body, p.photo, p.created_at, p.admin_id, a.name AS admin_name " +
        "FROM posts p LEFT JOIN admins a ON a.id = p.admin_id ORDER BY p.id DESC LIMIT 200"
      );
      const counts = await q("SELECT post_id, kind, COUNT(*)::int AS c FROM reactions GROUP BY post_id, kind");
      const rmap = {};
      for (const r of counts) {
        (rmap[r.post_id] = rmap[r.post_id] || [0, 0, 0, 0, 0, 0])[r.kind] = r.c;
      }
      const mine = {};
      if (voterOk) {
        for (const r of await q("SELECT post_id, kind FROM reactions WHERE voter = $1", [voter])) mine[r.post_id] = r.kind;
      }
      const cmap = {};
      const ids = posts.map((p) => p.id);
      if (ids.length) {
        const cs = await q("SELECT id, post_id, body, created_at FROM comments WHERE post_id = ANY($1::int[]) ORDER BY id", [ids]);
        for (const cm of cs) (cmap[cm.post_id] = cmap[cm.post_id] || []).push({ id: cm.id, text: cm.body, t: Number(cm.created_at) });
      }
      return send(200, posts.map((p) => {
        const name = p.admin_id != null ? p.admin_name || "Admin" : "Admin";
        return {
          id: p.id,
          text: p.body,
          photo: p.photo,
          t: Number(p.created_at),
          posted_by: name,
          admin_name: name,
          admin: p.admin_id != null ? { id: p.admin_id, name } : null,
          comments: cmap[p.id] || [],
          r: rmap[p.id] || [0, 0, 0, 0, 0, 0],
          mine: p.id in mine ? mine[p.id] : null,
        };
      }));
    }

    if (a === "posts" && !b && method === "POST") {
      const me = await needAdmin(req);
      const text = String(body.text ?? "").trim();
      if (text.length > 2000) fail(400, "Keep confessions under 2000 characters.");
      const photo = await savePhoto(body.photo);
      if (!text && !photo) fail(400, "Write a confession or choose a photo first.");
      const r = await q("INSERT INTO posts (body, photo, admin_id, created_at) VALUES ($1,$2,$3,$4) RETURNING id", [
        text, photo, me.id, nowMs(),
      ]);
      return send(201, { id: r[0].id });
    }

    if (a === "posts" && b && !c && (method === "PUT" || method === "DELETE")) {
      await needAdmin(req);
      const id = idNum(b);
      const ex = (await q("SELECT photo FROM posts WHERE id = $1", [id]))[0];
      if (method === "DELETE") {
        await q("DELETE FROM posts WHERE id = $1", [id]);
        if (ex) await removePhoto(ex.photo);
        return send(200, { ok: true });
      }
      if (!ex) fail(404, "Confession not found.");
      const text = String(body.text ?? "").trim();
      if (text.length > 2000) fail(400, "Keep confessions under 2000 characters.");
      let photo = ex.photo;
      if (body.removePhoto) photo = null;
      else if (body.photo) photo = await savePhoto(body.photo);
      if (!text && !photo) fail(400, "Write a confession or attach a photo first.");
      await q("UPDATE posts SET body = $1, photo = $2 WHERE id = $3", [text, photo, id]);
      if (ex.photo && ex.photo !== photo) await removePhoto(ex.photo);
      return send(200, { ok: true });
    }

    if (a === "posts" && b && c === "react" && method === "POST") {
      if (!voterOk) fail(400, "Missing voter id. Reload the page.");
      const id = idNum(b);
      if (!(await q("SELECT 1 FROM posts WHERE id = $1", [id]))[0]) fail(404, "Confession not found.");
      const kind = body.kind;
      if (kind === null || kind === undefined) {
        await q("DELETE FROM reactions WHERE post_id = $1 AND voter = $2", [id, voter]);
      } else if (Number.isInteger(kind) && kind >= 0 && kind <= 5) {
        await q(
          "INSERT INTO reactions (post_id, voter, kind) VALUES ($1,$2,$3) " +
          "ON CONFLICT (post_id, voter) DO UPDATE SET kind = EXCLUDED.kind",
          [id, voter, kind]
        );
      } else fail(400, "Invalid reaction.");
      return send(200, { ok: true });
    }

    if (a === "posts" && b && c === "comments" && method === "POST") {
      const id = idNum(b);
      const text = String(body.text ?? "").trim();
      if (!text) fail(400, "Write a comment first.");
      if (text.length > 1000) fail(400, "Keep comments under 1000 characters.");
      if (!(await q("SELECT 1 FROM posts WHERE id = $1", [id]))[0]) fail(404, "Confession not found.");
      await q("INSERT INTO comments (post_id, body, created_at) VALUES ($1,$2,$3)", [id, text, nowMs()]);
      return send(201, { ok: true });
    }

    /* ----- Admin auth ----- */
    if (a === "auth" && b === "login" && method === "POST") {
      const ip = clientIp(req);
      await checkAttempts(ip, "login");
      const email = String(body.email ?? "").trim().toLowerCase();
      const pass = String(body.password ?? "");
      const row = (await q("SELECT id, password_hash FROM admins WHERE email = $1", [email]))[0];
      const ok = await bcrypt.compare(pass, row ? row.password_hash : DUMMY_HASH);
      if (!row || !ok) {
        await addAttempt(ip);
        fail(401, "Wrong email or password. Check both and try again.");
      }
      await clearAttempts(ip);
      const token = sign({ t: "a", id: Number(row.id) });
      const admin = await currentAdmin({ headers: { authorization: "Bearer " + token } });
      return send(200, { token, admin });
    }

    if (a === "auth" && b === "me" && method === "GET") {
      const admin = await currentAdmin(req);
      if (!admin) fail(401, "Not logged in.");
      return send(200, { admin });
    }

    if (a === "auth" && b === "password" && method === "PUT") {
      const me = await needAdmin(req);
      const current = String(body.current ?? "");
      const next = String(body.next ?? "");
      if (!current) fail(400, "Enter your current password.");
      if (next.length < 8 || next.length > 72) fail(400, "New password must be 8 to 72 characters long.");
      const row = (await q("SELECT password_hash FROM admins WHERE id = $1", [me.id]))[0];
      if (!row || !(await bcrypt.compare(current, row.password_hash))) fail(401, "Current password is wrong.");
      await q("UPDATE admins SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(next, 10), me.id]);
      return send(200, { ok: true });
    }

    if (a === "settings" && b === "ngl" && method === "PUT") {
      const me = await needAdmin(req);
      let u;
      try { u = new URL(String(body.link ?? "").trim()); } catch (e) { u = null; }
      const okLink = u && ["http:", "https:"].includes(u.protocol) &&
        ["ngl.link", "www.ngl.link"].includes(u.hostname.toLowerCase()) && /^\/[A-Za-z0-9._-]+\/?$/.test(u.pathname);
      if (!okLink) fail(400, "Paste a full NGL link, like https://ngl.link/yourusername");
      const link = "https://ngl.link/" + u.pathname.replace(/^\/|\/$/g, "") + "/";
      await q("UPDATE admins SET ngl_link = $1 WHERE id = $2", [link, me.id]);
      return send(200, { ngl: link });
    }

    /* ----- Admins ----- */
    if (a === "admins" && !b && method === "GET") {
      await needAdmin(req);
      return send(200, await q("SELECT id, email, name, ngl_link AS ngl FROM admins ORDER BY id"));
    }
    if (a === "admins" && !b && method === "POST") {
      await needAdmin(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const pass = String(body.password ?? "");
      const name = (String(body.name ?? "").trim() || "Admin").slice(0, 60);
      if (!isEmail(email)) fail(400, "Enter a valid email address.");
      if (pass.length < 8 || pass.length > 72) fail(400, "Password needs 8 to 72 characters.");
      const r = await q(
        "INSERT INTO admins (email, name, password_hash, created_at) VALUES ($1,$2,$3,$4) " +
        "ON CONFLICT (email) DO NOTHING RETURNING id",
        [email, name, await bcrypt.hash(pass, 10), now()]
      );
      if (!r[0]) fail(409, "That email is already an admin.");
      return send(201, { ok: true });
    }
    if (a === "admins" && b && method === "DELETE") {
      const me = await needAdmin(req);
      const id = idNum(b);
      if (id === me.id) fail(400, "You can't remove your own account.");
      await q("DELETE FROM admins WHERE id = $1", [id]);
      return send(200, { ok: true });
    }

    /* ----- Member accounts ----- */
    if (a === "account" && b === "register" && method === "POST") {
      const ip = clientIp(req);
      await checkAttempts(ip, "sign-up");
      const name = String(body.name ?? "").trim().slice(0, 60);
      const email = String(body.email ?? "").trim().toLowerCase();
      const pass = String(body.password ?? "");
      if (!name) fail(400, "Enter your name.");
      if (!isEmail(email)) fail(400, "Enter a valid email address.");
      if (pass.length < 8 || pass.length > 72) fail(400, "Password must be 8 to 72 characters long.");
      const hash = await bcrypt.hash(pass, 10);
      const r = await q(
        "INSERT INTO members (email, name, password_hash, created_at) VALUES ($1,$2,$3,$4) " +
        "ON CONFLICT (email) DO NOTHING RETURNING id",
        [email, name, hash, now()]
      );
      if (!r[0]) fail(409, "An account with that email already exists. Log in instead.");
      await addAttempt(ip);
      return send(201, {
        token: sign({ t: "m", id: r[0].id, h: fingerprint(hash) }),
        member: { id: r[0].id, email, name },
      });
    }

    if (a === "account" && b === "login" && method === "POST") {
      const ip = clientIp(req);
      await checkAttempts(ip, "login");
      const email = String(body.email ?? "").trim().toLowerCase();
      const pass = String(body.password ?? "");
      const m = (await q("SELECT id, name, password_hash FROM members WHERE email = $1", [email]))[0];
      const ok = await bcrypt.compare(pass, m ? m.password_hash : DUMMY_HASH);
      if (!m || !ok) {
        await addAttempt(ip);
        fail(401, "Wrong email or password. Check both and try again.");
      }
      await clearAttempts(ip);
      return send(200, {
        token: sign({ t: "m", id: m.id, h: fingerprint(m.password_hash) }),
        member: { id: m.id, email, name: m.name },
      });
    }

    if (a === "account" && b === "me" && method === "GET") {
      const member = await currentMember(req);
      if (!member) fail(401, "Not logged in.");
      return send(200, { member });
    }

    return send(404, { error: "Not found." });
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message });
    console.error("NGL MB:", e);
    return send(500, { error: "Server error. Check that DATABASE_URL is set and the tables were created." });
  }
};
