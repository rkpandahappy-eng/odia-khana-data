// Odia Khana admin panel: edit recipes, Home picks, ads and contact links,
// then publish – saved to GitHub through /api/publish, served by Cloudflare.
import * as C from './content.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');

/** Escape text for HTML. */
const h = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = null; // loaded content + { repo, sha, email, manifest }
let dirty = false;
let password = '';
try { password = sessionStorage.getItem('admin_pw') || ''; } catch { /* private mode */ }

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('input', (e) => {
  if (e.target.closest('form')) dirty = true;
});

// ---------------------------------------------------------------- helpers

function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

class ApiError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail || code);
    this.code = code;
    Object.assign(this, extra);
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(password ? { 'x-admin-password': password } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Usually the sign-in expired: Cloudflare redirects to its login page.
    throw new ApiError('signed_out', 'Your sign-in has expired.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `http_${res.status}`, data.detail, data);
  return data;
}

const rawUrl = (path) =>
  `${S.rawBase || `https://raw.githubusercontent.com/${S.repo}/`}${S.sha}/${path}`;

async function fetchJson(path) {
  const res = await fetch(rawUrl(path), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/** Load the latest content straight from GitHub (exact commit, never stale). */
async function load() {
  const session = await api('session');
  S = { repo: session.repo, sha: session.sha, email: session.email, rawBase: session.raw_base };
  const [manifest, ...rest] = await Promise.all([
    fetchJson('manifest.json'),
    ...Object.values(C.FILES).map(fetchJson),
  ]);
  S.manifest = manifest;
  Object.keys(C.FILES).forEach((k, i) => { S[k] = rest[i]; });
}

/**
 * Apply a change and publish it. [change] gets the current content and
 * returns the changed parts, e.g. { recipes: [...] }; if someone else saved
 * in between, the latest content is loaded and the change applied again.
 */
async function publish(message, change, images = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = change(S);
    for (const k of Object.keys(parts)) {
      if (C.serialize(parts[k]) === C.serialize(S[k]) && !Object.keys(images).length) delete parts[k];
    }
    if (!Object.keys(parts).length && !Object.keys(images).length) return false; // nothing changed
    const next = { ...S, ...parts };
    const errors = C.contentErrors(next);
    if (errors.length) throw new ApiError('invalid', 'Please fix these first', { errors });
    const keys = Object.keys(parts);
    const manifest = C.bumpManifest(S.manifest, keys, C.todayIndia());
    const files = { 'manifest.json': C.serialize(manifest) };
    for (const k of keys) files[C.FILES[k]] = C.serialize(next[k]);
    try {
      const res = await api('publish', {
        method: 'POST',
        body: { base_sha: S.sha, message, files, images },
      });
      S = { ...next, manifest, sha: res.sha };
      dirty = false;
      watchLive(manifest.content_version);
      return true;
    } catch (e) {
      if (e.code === 'changed_elsewhere' && attempt === 0) {
        await load();
        continue;
      }
      throw e;
    }
  }
}

/** Show when Cloudflare serves the new version (usually within a minute). */
function watchLive(version) {
  const chip = $('#live');
  chip.hidden = false;
  chip.textContent = `Publishing v${version}…`;
  clearInterval(watchLive.timer);
  const started = Date.now();
  watchLive.timer = setInterval(async () => {
    try {
      const m = await fetch(`/manifest.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json());
      if (m.content_version >= version) {
        chip.textContent = `Live ✓ v${m.content_version}`;
        clearInterval(watchLive.timer);
        return;
      }
    } catch { /* keep trying */ }
    if (Date.now() - started > 5 * 60e3) {
      chip.textContent = `v${version} saved – still copying`;
      clearInterval(watchLive.timer);
    }
  }, 5000);
}

function showErrors(box, e) {
  const list = e.errors || [];
  const msg = {
    signed_out: 'Your sign-in has expired. Reload the page to sign in again.',
    github_token_missing: 'The GitHub key is not set up yet in Cloudflare.',
    github_refused: 'GitHub refused the save – the GitHub key may have expired.',
    changed_elsewhere: 'The data changed elsewhere. Reload the page and try again.',
    image_too_large: 'The photo is too large.',
  }[e.code] || e.message || 'Something went wrong.';
  box.innerHTML = `<div class="errors"><strong>${h(msg)}</strong>${
    list.length ? `<ul>${list.slice(0, 15).map((m) => `<li>${h(m)}</li>`).join('')}</ul>` : ''
  }${e.code === 'signed_out' ? '<p><button type="button" onclick="location.reload()">Reload</button></p>' : ''}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function withSaving(button, box, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Publishing…';
  box.innerHTML = '';
  try {
    const changed = await fn();
    dirty = false;
    toast(changed === false ? 'Nothing changed – nothing to publish.' : 'Published ✓ Phones get it within a few minutes.');
    return true;
  } catch (e) {
    showErrors(box, e);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/** Crop to [w]×[hgt], shrink, encode as WebP (JPEG where WebP isn't available). */
async function preparePhoto(file, w, hgt, maxBytes = 200 * 1024) {
  const bmp = await createImageBitmap(file);
  const target = w / hgt;
  let sw = bmp.width;
  let sh = bmp.height;
  let sx = 0;
  let sy = 0;
  if (sw / sh > target) { sw = sh * target; sx = (bmp.width - sw) / 2; } else { sh = sw / target; sy = (bmp.height - sh) / 2; }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, hgt);
  const encode = (type, q) => new Promise((ok) => canvas.toBlob(ok, type, q));
  let blob;
  let ext = 'webp';
  for (const q of [0.82, 0.72, 0.62, 0.5, 0.4]) {
    blob = await encode('image/webp', q);
    if (!blob || blob.type !== 'image/webp') { ext = 'jpg'; break; }
    if (blob.size <= maxBytes) break;
  }
  if (ext === 'jpg') {
    for (const q of [0.82, 0.72, 0.62, 0.5, 0.4]) {
      blob = await encode('image/jpeg', q);
      if (blob.size <= maxBytes) break;
    }
  }
  const dataUrl = await new Promise((ok) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.readAsDataURL(blob);
  });
  return { ext, dataUrl, base64: String(dataUrl).split(',')[1], size: blob.size };
}

const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);

/** Parse "1", "1.5", "1/2", "1 1/2", "½". */
function parseQuantity(s) {
  const t = String(s ?? '').trim().replace(',', '.')
    .replace('½', ' 1/2').replace('¼', ' 1/4').replace('¾', ' 3/4').trim();
  if (!t) return null;
  const m = t.match(/^(\d+(?:\.\d+)?)?\s*(?:(\d+)\s*\/\s*(\d+))?$/);
  if (!m || (!m[1] && !m[2])) return NaN;
  const whole = m[1] ? Number(m[1]) : 0;
  const frac = m[2] ? Number(m[2]) / Number(m[3]) : 0;
  return Math.round((whole + frac) * 1000) / 1000;
}

const photoUrl = (path) => (path ? `/${path}` : '');
const imgFallback = `onerror="this.style.visibility='hidden'"`;
const recipeName = (r) => r?.name?.or || r?.name?.en || r?.id;
const recipeLabel = (r) => [r?.name?.or, r?.name?.en].filter(Boolean).join(' · ') || r?.id;

function bilingual(prefix, value, { label, area = false, required = false } = {}) {
  const tag = (lang, ph) =>
    area
      ? `<textarea name="${prefix}.${lang}" placeholder="${ph}">${h(value?.[lang])}</textarea>`
      : `<input type="text" name="${prefix}.${lang}" value="${h(value?.[lang])}" placeholder="${ph}">`;
  return `<div class="field"><label>${h(label)}${required ? '' : ' (optional)'}</label>
    <div class="pair">${tag('or', 'ଓଡ଼ିଆରେ')}${tag('en', 'In English')}</div></div>`;
}

const read = (form, name) => form.elements[name]?.value ?? '';
const readText = (form, prefix) => C.text(read(form, `${prefix}.or`), read(form, `${prefix}.en`));

// ---------------------------------------------------------------- routing

function route() {
  const [tab, arg] = location.hash.replace(/^#/, '').split('/');
  $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (tab === 'recipe' ? 'recipes' : tab || 'recipes')));
  window.scrollTo(0, 0);
  dirty = false;
  switch (tab) {
    case 'recipe': return recipeEditor(arg === 'new' ? null : decodeURIComponent(arg || ''));
    case 'home': return homeView();
    case 'ads': return adsView();
    case 'settings': return settingsView();
    default: return recipesView();
  }
}

window.addEventListener('hashchange', (e) => {
  if (dirty && !confirm('Leave without publishing your changes?')) {
    history.replaceState(null, '', new URL(e.oldURL).hash || '#recipes');
    return;
  }
  dirty = false;
  route();
});

// ---------------------------------------------------------------- recipes

function recipesView() {
  const cats = Object.fromEntries(S.categories.map((c) => [c.id, c]));
  app.innerHTML = `
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search ${S.recipes.length} recipes" autocomplete="off">
      <a class="btn" href="#recipe/new" style="background:var(--accent);color:var(--accent-ink);border-color:var(--accent)">+ New</a>
    </div>
    <div class="card"><ul class="list" id="list"></ul></div>`;
  const list = $('#list');
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase().normalize('NFC');
    const rows = [...S.recipes].reverse().filter((r) =>
      !q || [r.name?.or, r.name?.en, r.id, ...(r.tags || [])].some((x) => String(x || '').toLowerCase().includes(q)));
    list.innerHTML = rows.slice(0, 300).map((r) => `
      <li data-id="${h(r.id)}">
        <img class="thumb" src="${h(photoUrl(r.image))}" alt="" loading="lazy" ${imgFallback}>
        <div class="names">
          <div class="or">${h(r.name?.or || r.name?.en)}</div>
          <div class="en">${h(r.name?.en)} · ${h(cats[r.category_id]?.name?.en || r.category_id)}
            ${r.is_published === false ? '<span class="badge bad">hidden</span>' : ''}
            ${r.video ? '<span class="badge">video</span>' : ''}</div>
        </div>
      </li>`).join('') || '<li class="muted">No recipe found</li>';
  };
  $('#q').addEventListener('input', draw);
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) location.hash = `#recipe/${encodeURIComponent(li.dataset.id)}`;
  });
  draw();
}

function ingredientRow(g = {}) {
  return `<div class="item" data-kind="ingredient" data-id="${h(g.id || '')}"
      data-extra="${h(JSON.stringify({ scalable: g.scalable, note: g.note }))}">
    <div class="item-head"><strong>Ingredient</strong>${moveButtons()}</div>
    <div class="pair">
      <input type="text" name="ing_or" value="${h(g.name?.or)}" placeholder="ଓଡ଼ିଆ ନାମ">
      <input type="text" name="ing_en" value="${h(g.name?.en)}" placeholder="English name">
    </div>
    <div class="row" style="margin-top:8px">
      <div class="field" style="margin:0"><input type="text" inputmode="decimal" name="ing_qty"
        value="${h(g.quantity ?? '')}" placeholder="Amount e.g. 1/2"></div>
      <div class="field" style="margin:0"><select name="ing_unit">${C.UNITS.map(([id, en, or]) =>
        `<option value="${id}" ${g.unit === id ? 'selected' : ''}>${h(en)} · ${h(or)}</option>`).join('')}</select></div>
    </div>
  </div>`;
}

function stepRow(s = {}) {
  const mins = s.timer_seconds ? Math.round((s.timer_seconds / 60) * 100) / 100 : '';
  return `<div class="item" data-kind="step" data-extra="${h(JSON.stringify({ image: s.image ?? null }))}">
    <div class="item-head"><strong class="step-no">Step</strong>${moveButtons()}</div>
    <div class="pair">
      <textarea name="step_or" placeholder="ଓଡ଼ିଆରେ">${h(s.text?.or)}</textarea>
      <textarea name="step_en" placeholder="In English">${h(s.text?.en)}</textarea>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="field" style="margin:0"><label>Timer in minutes (optional)</label>
        <input type="text" inputmode="decimal" name="step_timer" value="${h(mins)}" placeholder="e.g. 15"></div>
    </div>
    <details ${s.tip ? 'open' : ''}><summary>Tip for this step (optional)</summary>
      <div class="pair">
        <input type="text" name="step_tip_or" value="${h(s.tip?.or)}" placeholder="ଓଡ଼ିଆରେ">
        <input type="text" name="step_tip_en" value="${h(s.tip?.en)}" placeholder="In English">
      </div></details>
  </div>`;
}

function tipRow(t = {}) {
  return `<div class="item" data-kind="tip">
    <div class="item-head"><strong>Tip</strong>${moveButtons()}</div>
    <div class="pair">
      <input type="text" name="tip_or" value="${h(t.or)}" placeholder="ଓଡ଼ିଆରେ">
      <input type="text" name="tip_en" value="${h(t.en)}" placeholder="In English">
    </div></div>`;
}

function moveButtons() {
  return `<button type="button" class="icon" data-move="up" title="Move up">↑</button>
    <button type="button" class="icon" data-move="down" title="Move down">↓</button>
    <button type="button" class="icon danger" data-move="remove" title="Remove">✕</button>`;
}

function wireRows(form) {
  form.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-move]');
    if (b) {
      const item = b.closest('.item');
      if (b.dataset.move === 'up' && item.previousElementSibling) item.parentNode.insertBefore(item, item.previousElementSibling);
      if (b.dataset.move === 'down' && item.nextElementSibling) item.parentNode.insertBefore(item.nextElementSibling, item);
      if (b.dataset.move === 'remove' && confirm('Remove this?')) item.remove();
      dirty = true;
      numberSteps(form);
      return;
    }
    const add = e.target.closest('button[data-add]');
    if (add) {
      const box = $(`#${add.dataset.add}`, form);
      const html = { ingredients: ingredientRow, steps: stepRow, tips: tipRow }[add.dataset.add]();
      box.insertAdjacentHTML('beforeend', html);
      dirty = true;
      numberSteps(form);
      $('input, textarea', box.lastElementChild)?.focus();
    }
  });
}

function numberSteps(form) {
  $$('#steps .item', form).forEach((el, i) => { $('.step-no', el).textContent = `Step ${i + 1}`; });
}

function recipeEditor(id) {
  const original = id ? S.recipes.find((r) => r.id === id) : null;
  if (id && !original) { location.hash = '#recipes'; return; }
  const r = original || {
    cuisine: { or: 'ଓଡ଼ିଆ', en: 'Odia' }, food_type: 'vegetarian', difficulty: 'easy',
    prep_time_minutes: 10, cook_time_minutes: 20, default_servings: 4,
    ingredients: [{}, {}, {}], instructions: [{}, {}], tips: [], is_published: true,
  };
  let photo = null; // { ext, dataUrl, base64 }
  app.innerHTML = `
    <p><a href="#recipes">← All recipes</a></p>
    <h1>${original ? h(recipeLabel(original)) : 'New recipe'}</h1>
    <div id="errs"></div>
    <form id="f" autocomplete="off">
      <div class="card">
        <h2>Basics</h2>
        ${bilingual('name', r.name, { label: 'Name', required: true })}
        ${bilingual('description', r.description, { label: 'Short description', area: true, required: true })}
        <div class="row">
          <div class="field"><label>Category</label><select name="category_id">
            <option value="">Choose…</option>
            ${[...S.categories].sort((a, b) => a.display_order - b.display_order).map((c) =>
              `<option value="${h(c.id)}" ${r.category_id === c.id ? 'selected' : ''}>${h(c.name.or)} · ${h(c.name.en)}</option>`).join('')}
          </select></div>
          <div class="field"><label>Veg / non-veg</label><select name="food_type">
            <option value="vegetarian" ${r.food_type === 'vegetarian' ? 'selected' : ''}>Veg · ନିରାମିଷ</option>
            <option value="non_vegetarian" ${r.food_type === 'non_vegetarian' ? 'selected' : ''}>Non-veg · ଆମିଷ</option>
          </select></div>
          <div class="field"><label>Difficulty</label><select name="difficulty">
            ${['easy', 'medium', 'hard'].map((d) => `<option value="${d}" ${r.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select></div>
        </div>
        <div class="row">
          <div class="field"><label>Preparation (minutes)</label><input type="number" min="0" name="prep" value="${h(r.prep_time_minutes)}"></div>
          <div class="field"><label>Cooking (minutes)</label><input type="number" min="0" name="cook" value="${h(r.cook_time_minutes)}"></div>
          <div class="field"><label>Serves</label><input type="number" min="1" name="servings" value="${h(r.default_servings)}"></div>
        </div>
        ${bilingual('cuisine', r.cuisine, { label: 'Cuisine' })}
        <div class="field"><label>Search words, separated by commas (optional)</label>
          <input type="text" name="tags" value="${h((r.tags || []).join(', '))}" placeholder="veg, lunch, festival"></div>
        <label class="check"><input type="checkbox" name="is_published" ${r.is_published !== false ? 'checked' : ''}> Show in the app</label>
        <label class="check"><input type="checkbox" name="is_verified" ${r.is_verified ? 'checked' : ''}> Quantities and steps checked</label>
      </div>

      <div class="card">
        <h2>Photo</h2>
        <div class="photo">
          <img id="photo-preview" src="${h(photoUrl(r.image))}" alt="" ${imgFallback}>
          <div>
            <input type="file" id="photo" accept="image/*">
            <p class="muted small">Any phone photo. It is cropped to 4:3 and made small automatically.
            ${r.image ? `<br>Current: ${h(r.image)}` : ''}</p>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Making video (optional)</h2>
        <div class="field"><label>YouTube or Shorts link</label>
          <input type="url" name="video_link" value="${h(r.video ? `https://www.youtube.com/shorts/${r.video.youtube_id}` : '')}" placeholder="https://www.youtube.com/shorts/…"></div>
        <div class="row">
          <div class="field"><label>Video by (channel name)</label><input type="text" name="video_credit" value="${h(r.video?.credit)}"></div>
          <div class="field"><label>Video title (optional)</label><input type="text" name="video_title" value="${h(r.video?.title)}"></div>
        </div>
        <p class="muted small">Use your own videos, or ones whose makers allow embedding.</p>
      </div>

      <div class="card">
        <h2>Ingredients</h2>
        <div id="ingredients">${r.ingredients.map(ingredientRow).join('')}</div>
        <button type="button" data-add="ingredients">+ Add ingredient</button>
      </div>

      <div class="card">
        <h2>Steps</h2>
        <div id="steps">${r.instructions.map(stepRow).join('')}</div>
        <button type="button" data-add="steps">+ Add step</button>
      </div>

      <div class="card">
        <h2>Tips (optional)</h2>
        <div id="tips">${(r.tips || []).map(tipRow).join('')}</div>
        <button type="button" data-add="tips">+ Add tip</button>
        <div style="margin-top:14px">${bilingual('serving', r.serving_suggestion, { label: 'Serving suggestion' })}</div>
      </div>
    </form>
    <div class="actions">
      <button type="button" onclick="history.back()">Cancel</button>
      <button type="button" class="primary" id="save">${original ? 'Publish changes' : 'Publish recipe'}</button>
    </div>`;
  const form = $('#f');
  wireRows(form);
  numberSteps(form);

  $('#photo').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      photo = await preparePhoto(file, 900, 675);
      $('#photo-preview').src = photo.dataUrl;
      $('#photo-preview').style.visibility = 'visible';
      dirty = true;
      toast(`Photo ready (${Math.round(photo.size / 1024)} KB)`);
    } catch {
      toast('That file could not be read as a photo.');
    }
  });

  $('#save').addEventListener('click', () => {
    const box = $('#errs');
    let recipe;
    let images = {};
    try {
      ({ recipe, images } = readRecipe(form, original, photo));
    } catch (e) {
      showErrors(box, e);
      return;
    }
    const verb = original ? 'Edit' : 'Add';
    withSaving($('#save'), box, () =>
      publish(`${verb} recipe: ${recipe.name.en || recipe.id}`, (s) => ({ recipes: C.upsert(s.recipes, recipe) }), images),
    ).then((ok) => {
      if (ok) location.hash = `#recipe/${encodeURIComponent(recipe.id)}`;
      if (ok && original) recipeEditor(recipe.id);
    });
  });
}

/** Build the recipe object from the form (keeps fields the form doesn't show). */
function readRecipe(form, original, photo) {
  const problems = [];
  const name = readText(form, 'name');
  const ids = new Set(S.recipes.map((x) => x.id));
  const slugs = new Set(S.recipes.filter((x) => x.id !== original?.id).map((x) => x.slug));
  const id = original?.id || C.newRecipeId(name.en || name.or, ids);
  const slug = original?.slug || C.uniqueSlug(name.en || id.replace(/^odia_|_\d+$/g, ''), slugs);

  const taken = new Set();
  const ingredients = $$('#ingredients .item', form).map((el) => {
    const or = C.cleanText($('[name=ing_or]', el).value);
    const en = C.cleanText($('[name=ing_en]', el).value);
    const qtyText = $('[name=ing_qty]', el).value;
    if (!or && !en && !qtyText.trim()) return null; // empty row
    const unit = $('[name=ing_unit]', el).value;
    const extra = JSON.parse(el.dataset.extra || '{}');
    let gid = el.dataset.id;
    if (gid && !taken.has(gid)) taken.add(gid); else gid = C.ingredientId(en || or || 'item', taken);
    let quantity = C.UNMEASURED.has(unit) ? null : parseQuantity(qtyText);
    if (Number.isNaN(quantity)) { problems.push(`Ingredient "${en || or}": amount "${qtyText}" is not a number`); quantity = null; }
    const g = { id: gid, name: { or, en }, quantity, unit,
      scalable: C.UNMEASURED.has(unit) ? false : extra.scalable ?? true };
    if (extra.note) g.note = extra.note;
    return g;
  }).filter(Boolean);

  const instructions = $$('#steps .item', form).map((el) => {
    const t = C.text($('[name=step_or]', el).value, $('[name=step_en]', el).value);
    if (!t.or && !t.en) return null;
    const extra = JSON.parse(el.dataset.extra || '{}');
    const minsText = $('[name=step_timer]', el).value.trim().replace(',', '.');
    let timer = null;
    if (minsText) {
      const mins = Number(minsText);
      if (!(mins > 0)) problems.push(`A step timer "${minsText}" is not a number of minutes`);
      else timer = Math.max(1, Math.round(mins * 60));
    }
    const step = { step: 0, text: t, image: extra.image ?? null, timer_seconds: timer };
    const tip = C.text($('[name=step_tip_or]', el).value, $('[name=step_tip_en]', el).value);
    if (tip.or || tip.en) step.tip = tip;
    return step;
  }).filter(Boolean).map((s, i) => ({ ...s, step: i + 1 }));

  const tips = $$('#tips .item', form)
    .map((el) => C.text($('[name=tip_or]', el).value, $('[name=tip_en]', el).value))
    .filter((t) => t.or || t.en);

  const images = {};
  let image = original?.image ?? null;
  if (photo) {
    image = `images/recipes/${slug}-${stamp()}.${photo.ext}`;
    images[image] = photo.base64;
  }

  const int = (v) => (String(v).trim() === '' ? NaN : Number(v));
  const recipe = {
    ...(original || {}),
    id,
    slug,
    name,
    description: readText(form, 'description'),
    category_id: read(form, 'category_id'),
    food_type: read(form, 'food_type'),
    prep_time_minutes: int(read(form, 'prep')),
    cook_time_minutes: int(read(form, 'cook')),
    difficulty: read(form, 'difficulty'),
    default_servings: int(read(form, 'servings')),
    cuisine: readText(form, 'cuisine'),
    ingredients,
    instructions,
    tips,
    image,
    tags: read(form, 'tags').split(',').map((t) => C.cleanText(t).toLowerCase()).filter(Boolean),
    is_featured: original?.is_featured ?? false,
    is_published: form.elements.is_published.checked,
    is_verified: form.elements.is_verified.checked,
    published_at: original?.published_at || C.todayIndia(),
  };
  if (!C.hasText(recipe.cuisine)) delete recipe.cuisine;
  const serving = readText(form, 'serving');
  if (C.hasText(serving)) recipe.serving_suggestion = serving; else delete recipe.serving_suggestion;

  const link = read(form, 'video_link').trim();
  if (link) {
    const vid = C.youtubeId(link);
    if (!vid) problems.push('The video link is not a YouTube link');
    const video = { youtube_id: vid || '', credit: C.cleanText(read(form, 'video_credit')) };
    const title = C.cleanText(read(form, 'video_title'));
    if (title) video.title = title;
    recipe.video = video;
  } else {
    delete recipe.video;
  }

  if (!recipe.category_id) problems.push('Choose a category');
  problems.push(...C.recipeErrors(recipe));
  if (problems.length) throw new ApiError('invalid', 'Please fix these first', { errors: [...new Set(problems)] });
  return { recipe, images };
}

// ---------------------------------------------------------------- home

function recipePicker(container, { onPick, placeholder }) {
  container.innerHTML = `<input type="search" placeholder="${h(placeholder)}" autocomplete="off">
    <div class="picker" hidden></div>`;
  const input = $('input', container);
  const box = $('.picker', container);
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase().normalize('NFC');
    const rows = q ? S.recipes.filter((r) => r.is_published !== false &&
      [r.name?.or, r.name?.en].some((x) => String(x || '').toLowerCase().includes(q))).slice(0, 30) : [];
    box.hidden = !rows.length;
    box.innerHTML = rows.map((r) => `<div data-id="${h(r.id)}">${h(recipeLabel(r))}</div>`).join('');
  });
  box.addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    onPick(row.dataset.id);
    input.value = '';
    box.hidden = true;
    dirty = true;
  });
}

function homeView() {
  const f = structuredClone(S.featured);
  f.popular_recipe_ids ||= [];
  const byId = Object.fromEntries(S.recipes.map((r) => [r.id, r]));
  app.innerHTML = `
    <h1>Home screen</h1>
    <div id="errs"></div>
    <form id="f">
      <div class="card">
        <h2>Today's Special</h2>
        <div class="chosen" id="special"></div>
        <div id="special-pick"></div>
      </div>
      <div class="card">
        <h2>Popular recipes</h2>
        <div id="popular"></div>
        <div id="popular-pick" style="margin-top:8px"></div>
      </div>
    </form>
    <div class="actions"><button type="button" class="primary" id="save">Publish Home changes</button></div>`;
  const drawSpecial = () => {
    $('#special').textContent = f.todays_special_id ? recipeLabel(byId[f.todays_special_id]) : 'None chosen';
  };
  const drawPopular = () => {
    $('#popular').innerHTML = f.popular_recipe_ids.map((id, i) => `
      <div class="item" data-i="${i}"><div class="item-head"><strong>${i + 1}. ${h(recipeLabel(byId[id]))}</strong>
      <button type="button" class="icon" data-act="up">↑</button>
      <button type="button" class="icon" data-act="down">↓</button>
      <button type="button" class="icon danger" data-act="remove">✕</button></div></div>`).join('') ||
      '<p class="muted">No popular recipes.</p>';
  };
  recipePicker($('#special-pick'), {
    placeholder: 'Search to change Today’s Special',
    onPick: (id) => { f.todays_special_id = id; drawSpecial(); },
  });
  recipePicker($('#popular-pick'), {
    placeholder: 'Search to add a popular recipe',
    onPick: (id) => { if (!f.popular_recipe_ids.includes(id)) f.popular_recipe_ids.push(id); drawPopular(); },
  });
  $('#popular').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const i = Number(b.closest('.item').dataset.i);
    const list = f.popular_recipe_ids;
    if (b.dataset.act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (b.dataset.act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    if (b.dataset.act === 'remove') list.splice(i, 1);
    dirty = true;
    drawPopular();
  });
  drawSpecial();
  drawPopular();
  $('#save').addEventListener('click', () => {
    withSaving($('#save'), $('#errs'), () => publish('Update Home: Today’s Special and Popular', () => ({ featured: f })));
  });
}

// ---------------------------------------------------------------- ads

function adsView() {
  app.innerHTML = `
    <h1>Ads</h1>
    <div id="errs"></div>
    <form id="f"><div id="ads">${S.advertisements.map(adCard).join('')}</div>
      <button type="button" id="add-ad">+ Add ad</button></form>
    <div class="actions"><button type="button" class="primary" id="save">Publish ad changes</button></div>`;
  const pictures = {}; // ad id → prepared photo
  const form = $('#f');
  $('#add-ad').addEventListener('click', () => {
    const taken = new Set($$('#ads [data-ad]').map((el) => el.dataset.ad));
    let n = 1;
    while (taken.has(`ad_${n}`)) n++;
    $('#ads').insertAdjacentHTML('beforeend', adCard({
      id: `ad_${n}`, placement: 'home_card', is_active: true, is_sponsored: false,
      action: { type: 'url', value: 'https://' },
    }));
    dirty = true;
  });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-remove-ad]');
    if (b && confirm('Delete this ad?')) { b.closest('[data-ad]').remove(); dirty = true; }
  });
  form.addEventListener('change', async (e) => {
    if (e.target.name === 'placement') {
      $('.recipe-for', e.target.closest('[data-ad]')).hidden = e.target.value !== 'recipe';
    }
    if (e.target.type === 'file') {
      const card = e.target.closest('[data-ad]');
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        pictures[card.dataset.ad] = await preparePhoto(file, 300, 300, 80 * 1024);
        $('img', card).src = pictures[card.dataset.ad].dataUrl;
        $('img', card).style.visibility = 'visible';
      } catch { toast('That file could not be read as a picture.'); }
    }
    if (e.target.name === 'remove_picture' && e.target.checked) {
      delete pictures[e.target.closest('[data-ad]').dataset.ad];
    }
  });
  $('#save').addEventListener('click', () => {
    const images = {};
    const ads = $$('#ads [data-ad]').map((card) => readAd(card, pictures, images));
    withSaving($('#save'), $('#errs'), () => publish('Update ads', () => ({ advertisements: ads }), images));
  });
}

function adCard(a) {
  const recipeOptions = S.recipes.filter((r) => r.is_published !== false)
    .map((r) => `<option value="${h(r.id)}" ${a.recipe_id === r.id ? 'selected' : ''}>${h(recipeLabel(r))}</option>`).join('');
  const t = a.action?.type || 'url';
  return `<div class="card" data-ad="${h(a.id)}" data-extra="${h(JSON.stringify({ image: a.image ?? null }))}">
    <div class="item-head"><strong>${h(a.title?.en || a.title?.or || a.id)}</strong>
      <button type="button" class="icon danger" data-remove-ad>Delete</button></div>
    <label class="check"><input type="checkbox" name="is_active" ${a.is_active !== false ? 'checked' : ''}> Show this ad</label>
    <label class="check"><input type="checkbox" name="is_sponsored" ${a.is_sponsored ? 'checked' : ''}> Paid sponsor (shows “Sponsored”)</label>
    ${bilingual('title', a.title, { label: 'Title', required: true })}
    ${bilingual('description', a.description, { label: 'Text', area: true, required: true })}
    ${bilingual('cta', a.cta_label, { label: 'Button text' })}
    <div class="row">
      <div class="field"><label>Button opens</label><select name="action_type">
        ${[['url', 'Website link'], ['email', 'Email'], ['phone', 'Phone call'], ['whatsapp', 'WhatsApp']].map(([v, l]) =>
          `<option value="${v}" ${t === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
      <div class="field"><label>Link, email or number</label>
        <input type="text" name="action_value" value="${h(a.action?.value)}"></div>
    </div>
    <div class="field"><label>Email subject (only for Email, optional)</label>
      <input type="text" name="action_subject" value="${h(a.action?.subject)}"></div>
    <div class="row">
      <div class="field"><label>Where it shows</label><select name="placement">
        <option value="home_card" ${a.placement !== 'recipe' ? 'selected' : ''}>Home screen</option>
        <option value="recipe" ${a.placement === 'recipe' ? 'selected' : ''}>On one recipe</option>
      </select></div>
      <div class="field recipe-for" ${a.placement === 'recipe' ? '' : 'hidden'}><label>Recipe</label>
        <select name="recipe_id"><option value="">Choose…</option>${recipeOptions}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Start date (optional)</label><input type="date" name="starts_on" value="${h(a.starts_on)}"></div>
      <div class="field"><label>End date (optional)</label><input type="date" name="ends_on" value="${h(a.ends_on)}"></div>
    </div>
    <div class="photo">
      <img class="square" src="${h(photoUrl(a.image))}" alt="" ${imgFallback}>
      <div><label>Picture (optional, square)</label><input type="file" accept="image/*">
        ${a.image ? '<label class="check"><input type="checkbox" name="remove_picture"> Remove picture</label>' : ''}</div>
    </div>
  </div>`;
}

function readAd(card, pictures, images) {
  const id = card.dataset.ad;
  const q = (n) => $(`[name="${n}"]`, card);
  const t = (prefix) => C.text(q(`${prefix}.or`).value, q(`${prefix}.en`).value);
  const extra = JSON.parse(card.dataset.extra || '{}');
  const original = S.advertisements.find((a) => a.id === id) || {};
  const ad = {
    ...original,
    id,
    placement: q('placement').value,
    is_active: q('is_active').checked,
    is_sponsored: q('is_sponsored').checked,
    title: t('title'),
    description: t('description'),
    image: extra.image,
    action: { type: q('action_type').value, value: q('action_value').value.trim() },
  };
  if (ad.placement === 'recipe') ad.recipe_id = q('recipe_id').value; else delete ad.recipe_id;
  const cta = t('cta');
  if (C.hasText(cta)) ad.cta_label = cta; else delete ad.cta_label;
  const subject = C.cleanText(q('action_subject').value);
  if (subject && ad.action.type === 'email') ad.action.subject = subject;
  for (const k of ['starts_on', 'ends_on']) {
    if (q(k).value) ad[k] = q(k).value; else delete ad[k];
  }
  if (q('remove_picture')?.checked) ad.image = null;
  if (pictures[id]) {
    ad.image = `images/ads/${id.replace(/_/g, '-')}-${stamp()}.${pictures[id].ext}`;
    images[ad.image] = pictures[id].base64;
  }
  return ad;
}

// ---------------------------------------------------------------- contact

function settingsView() {
  const c = S.app_config;
  app.innerHTML = `
    <h1>Contact and links</h1>
    <div id="errs"></div>
    <form id="f" class="card">
      <div class="field"><label>Contact email (shown in the app)</label>
        <input type="email" name="contact_email" value="${h(c.contact_email)}"></div>
      <div class="field"><label>Share link (sent when someone shares the app)</label>
        <input type="url" name="share_url" value="${h(c.share_url)}"></div>
      <div class="field"><label>Privacy policy link</label>
        <input type="url" name="privacy_policy_url" value="${h(c.privacy_policy_url)}"></div>
    </form>
    <p class="muted small">Signed in as ${h(S.email)} · data version ${h(S.manifest.content_version)}</p>
    <div class="actions"><button type="button" class="primary" id="save">Publish contact changes</button></div>`;
  $('#save').addEventListener('click', () => {
    const form = $('#f');
    const v = (n) => form.elements[n].value.trim() || null;
    const next = { ...c, contact_email: v('contact_email'), share_url: v('share_url'), privacy_policy_url: v('privacy_policy_url') };
    withSaving($('#save'), $('#errs'), () => publish('Update contact and links', () => ({ app_config: next })));
  });
}

// ---------------------------------------------------------------- start

function passwordView(wrong) {
  app.innerHTML = `<form class="card" id="pw" style="max-width:380px;margin:40px auto">
    <h2>Sign in</h2>
    ${wrong ? '<p class="errors">Wrong password.</p>' : ''}
    <div class="field"><label>Admin password</label><input type="password" name="pw" autofocus></div>
    <button class="primary" type="submit">Sign in</button></form>`;
  $('#pw').addEventListener('submit', (e) => {
    e.preventDefault();
    password = e.target.elements.pw.value;
    try { sessionStorage.setItem('admin_pw', password); } catch { /* ignore */ }
    start();
  });
}

async function start() {
  try {
    await load();
  } catch (e) {
    if (e.code === 'not_signed_in' && e.auth === 'password') return passwordView(!!password);
    const msg = {
      not_signed_in: {
        not_configured: 'The admin panel is not switched on yet (sign-in is not set up in Cloudflare).',
        weak_password: 'The admin password in Cloudflare is too short. Use at least 12 characters.',
      }[e.auth] || 'You are not allowed to use the admin panel.',
      signed_out: 'Your sign-in has expired. Reload the page.',
      github_token_missing: 'The GitHub key is not set up yet in Cloudflare.',
      github_refused: 'GitHub refused – the GitHub key may be wrong or expired.',
    }[e.code] || `Could not load the recipes (${e.message}).`;
    app.innerHTML = `<div class="card center"><p>${h(msg)}</p><button onclick="location.reload()">Try again</button></div>`;
    return;
  }
  $('#tabs').hidden = false;
  route();
}

start();
