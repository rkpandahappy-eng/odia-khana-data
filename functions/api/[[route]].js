// Admin API for the Odia Khana data repository (Cloudflare Pages Function).
//
//   GET  /api/session   who is signed in + the latest commit of the data
//   POST /api/publish   save changed files to GitHub in one commit
//
// Sign-in: Cloudflare Access (email code) protects /admin and /api. This code
// checks the Access token itself as well, so the API stays closed even if
// Access is switched off by mistake. Without Access settings it falls back
// to a password (ADMIN_PASSWORD), and with neither it refuses everyone.
//
// Settings (Cloudflare → Pages project → Settings → Variables and Secrets):
//   GITHUB_TOKEN        secret – fine-grained token, Contents read/write on
//                       odia-khana-data only
//   ACCESS_TEAM_DOMAIN  e.g. https://odiakhana.cloudflareaccess.com
//   ACCESS_AUD          the Access application's "Application Audience" tag
//   ADMIN_EMAILS        optional, comma-separated emails allowed in
//   ADMIN_PASSWORD      secret, only if Access is not used
//   GITHUB_REPO         optional, default rkpandahappy-eng/odia-khana-data
//
// Heavy work (checking recipes, raising version numbers) happens in the
// browser; this function only checks who you are and which files you may
// change, then writes them to GitHub. That keeps it inside Cloudflare's free
// CPU limit.

const DEFAULT_REPO = 'rkpandahappy-eng/odia-khana-data';
const BRANCH = 'main';

const DATA_FILE =
  /^(manifest\.json|data\/(recipes|categories|featured|advertisements|app_config)\.json)$/;
const IMAGE_FILE = /^images\/(recipes|ads|categories)\/[a-z0-9][a-z0-9-]{0,90}\.(webp|jpg)$/;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 900 * 1024;
const MAX_IMAGES = 10;

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = [].concat(params.route || []).join('/');
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return json({ error: 'not_signed_in', auth: authMode(env) }, 401);
    }
    if (route === 'session' && request.method === 'GET') {
      return await session(env, user);
    }
    if (route === 'publish' && request.method === 'POST') {
      checkSameOrigin(request);
      return await publish(request, env);
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    return json(
      { error: e instanceof ApiError ? e.code : 'server_error', detail: e.message, ...e.extra },
      status,
    );
  }
}

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------- sign-in

export function authMode(env) {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) return 'access';
  if (env.ADMIN_PASSWORD) return 'password';
  return 'not_configured';
}

export async function authenticate(request, env, fetchImpl = fetch) {
  const mode = authMode(env);
  if (mode === 'access') {
    const token =
      request.headers.get('cf-access-jwt-assertion') ||
      cookie(request.headers.get('cookie'), 'CF_Authorization');
    if (!token) return null;
    const claims = await verifyAccessJwt(token, env, fetchImpl);
    if (!claims) return null;
    const email = String(claims.email || '').toLowerCase();
    const allowed = String(env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length && !allowed.includes(email)) return null;
    return { email };
  }
  if (mode === 'password') {
    const given = request.headers.get('x-admin-password') || '';
    return (await sameSecret(given, env.ADMIN_PASSWORD)) ? { email: 'admin' } : null;
  }
  return null; // nothing configured: closed to everyone
}

function cookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function sameSecret(a, b) {
  // Compare hashes so the time taken doesn't reveal the password.
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && String(b).length > 0;
}

let certCache = { url: '', keys: [], at: 0 };

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function accessKeys(team, fetchImpl, force) {
  const url = `${team.replace(/\/$/, '')}/cdn-cgi/access/certs`;
  if (!force && certCache.url === url && Date.now() - certCache.at < 3600e3) {
    return certCache.keys;
  }
  const res = await fetchImpl(url);
  if (!res.ok) throw new ApiError(502, 'access_certs_unavailable');
  const keys = (await res.json()).keys || [];
  certCache = { url, keys, at: Date.now() };
  return keys;
}

export async function verifyAccessJwt(token, env, fetchImpl = fetch) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let header;
  let claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;
  const team = String(env.ACCESS_TEAM_DOMAIN).replace(/\/$/, '');
  let keys = await accessKeys(team, fetchImpl, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await accessKeys(team, fetchImpl, true); // keys rotate
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const aud = [].concat(claims.aud || []);
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (typeof claims.exp !== 'number' || claims.exp < now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
  if (claims.iss !== team) return null;
  return claims;
}

function checkSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, 'wrong_origin');
  }
}

// ---------------------------------------------------------------- GitHub

function github(env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN) {
    throw new ApiError(503, 'github_token_missing', 'GITHUB_TOKEN is not set');
  }
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'odia-khana-admin',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(502, 'github_refused', `GitHub ${res.status}: ${text.slice(0, 200)}`);
      }
      if (res.status === 409 || res.status === 422) {
        throw new ApiError(409, 'changed_elsewhere', `GitHub ${res.status}`);
      }
      throw new ApiError(502, 'github_error', `GitHub ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  };
}

async function headSha(gh) {
  const ref = await gh('GET', `/git/ref/heads/${BRANCH}`);
  return ref.object.sha;
}

async function session(env, user, fetchImpl = fetch) {
  const gh = github(env, fetchImpl);
  return json({
    email: user.email,
    repo: env.GITHUB_REPO || DEFAULT_REPO,
    branch: BRANCH,
    sha: await headSha(gh),
    // Only for local testing with a fake GitHub; unset in production.
    ...(env.RAW_BASE ? { raw_base: env.RAW_BASE } : {}),
  });
}

/** Checks a publish request; returns a clean list of files to write. */
export function checkPublishBody(body) {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'bad_request');
  const { base_sha, message, files = {}, images = {} } = body;
  if (!/^[0-9a-f]{40}$/.test(String(base_sha))) {
    throw new ApiError(400, 'bad_request', 'base_sha missing');
  }
  const out = [];
  for (const [path, text] of Object.entries(files)) {
    if (!DATA_FILE.test(path)) throw new ApiError(400, 'file_not_allowed', path);
    if (typeof text !== 'string' || !/^\s*[[{]/.test(text)) {
      throw new ApiError(400, 'bad_file', path);
    }
    if (text.length > MAX_TEXT_BYTES) throw new ApiError(413, 'file_too_large', path);
    out.push({ path, content: text, encoding: 'utf-8' });
  }
  const imageEntries = Object.entries(images);
  if (imageEntries.length > MAX_IMAGES) throw new ApiError(400, 'too_many_images');
  for (const [path, b64] of imageEntries) {
    if (!IMAGE_FILE.test(path)) throw new ApiError(400, 'file_not_allowed', path);
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw new ApiError(400, 'bad_image', path);
    }
    if ((b64.length * 3) / 4 > MAX_IMAGE_BYTES) throw new ApiError(413, 'image_too_large', path);
    const head = atob(b64.slice(0, 16));
    const isWebp = head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
    const isJpeg = head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8;
    if (!(path.endsWith('.webp') ? isWebp : isJpeg)) throw new ApiError(400, 'bad_image', path);
    out.push({ path, content: b64, encoding: 'base64' });
  }
  if (!out.length) throw new ApiError(400, 'nothing_to_save');
  if (out.some((f) => f.path.startsWith('data/')) && !files['manifest.json']) {
    throw new ApiError(400, 'manifest_required', 'data changes need a new manifest.json');
  }
  const text = String(message || 'Update content').replace(/[\r\n]+/g, ' ').slice(0, 120);
  return { baseSha: base_sha, message: text, files: out };
}

export async function publish(request, env, fetchImpl = fetch) {
  const { baseSha, message, files } = checkPublishBody(await request.json());
  const gh = github(env, fetchImpl);
  const head = await headSha(gh);
  if (head !== baseSha) {
    throw new ApiError(409, 'changed_elsewhere', 'the data changed since it was loaded', {
      sha: head,
    });
  }
  const parent = await gh('GET', `/git/commits/${head}`);
  const tree = [];
  for (const f of files) {
    const blob = await gh('POST', '/git/blobs', { content: f.content, encoding: f.encoding });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh('POST', '/git/trees', { base_tree: parent.tree.sha, tree });
  const commit = await gh('POST', '/git/commits', {
    message: `${message}\n\nPublished from the admin panel.`,
    tree: newTree.sha,
    parents: [head],
  });
  await gh('PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  return json({ sha: commit.sha, files: files.map((f) => f.path) });
}
