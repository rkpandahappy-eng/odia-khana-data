// Content rules for the admin panel: the same checks as the schemas in
// schema/, the GitHub check and the app itself, so a published change can
// never be refused by phones. Pure functions – used by the panel and tests.

export const FILES = {
  recipes: 'data/recipes.json',
  categories: 'data/categories.json',
  featured: 'data/featured.json',
  advertisements: 'data/advertisements.json',
  app_config: 'data/app_config.json',
};

export const UNITS = [
  ['cup', 'cup', 'କପ୍'],
  ['tbsp', 'tablespoon', 'ବଡ଼ ଚାମଚ'],
  ['tsp', 'teaspoon', 'ଛୋଟ ଚାମଚ'],
  ['g', 'gram', 'ଗ୍ରାମ'],
  ['kg', 'kilogram', 'କିଲୋ'],
  ['ml', 'ml', 'ମିଲି'],
  ['litre', 'litre', 'ଲିଟର'],
  ['piece', 'piece', 'ଗୋଟା'],
  ['pinch', 'pinch', 'ଚିମୁଟେ'],
  ['handful', 'handful', 'ମୁଠାଏ'],
  ['to_taste', 'to taste', 'ସ୍ୱାଦ ଅନୁସାରେ'],
  ['as_required', 'as required', 'ଆବଶ୍ୟକ ଅନୁସାରେ'],
];
const UNIT_IDS = new Set(UNITS.map((u) => u[0]));
export const UNMEASURED = new Set(['to_taste', 'as_required']);

/** One standard form for Odia and English text (as the app's data uses). */
export function cleanText(s) {
  return String(s ?? '').normalize('NFC').replace(/[ \t]+/g, ' ').trim();
}

export function text(or, en) {
  return { or: cleanText(or), en: cleanText(en) };
}

export function hasText(t) {
  return !!t && typeof t === 'object' && (!!cleanText(t.or) || !!cleanText(t.en));
}

export function slugify(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function uniqueSlug(name, taken) {
  const base = slugify(name) || 'recipe';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export function newRecipeId(enName, takenIds) {
  const base = `odia_${(slugify(enName) || 'recipe').replace(/-/g, '_')}`;
  for (let n = 1; ; n++) {
    const id = `${base}_${String(n).padStart(3, '0')}`;
    if (!takenIds.has(id)) return id;
  }
}

export function ingredientId(enName, taken) {
  const base = (slugify(enName) || 'item').replace(/-/g, '_');
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

/** YouTube id from a Shorts/watch/share link or a bare id; null if none. */
export function youtubeId(input) {
  const s = String(input ?? '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m =
    s.match(/(?:youtube\.com\/(?:shorts\/|embed\/|live\/|watch\?(?:.*&)?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/) ||
    null;
  return m ? m[1] : null;
}

/** Today's date in India, YYYY-MM-DD. */
export function todayIndia(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600e3);
  return ist.toISOString().slice(0, 10);
}

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** New manifest: content_version + 1 and each changed file's own version. */
export function bumpManifest(manifest, changedKeys, today) {
  const next = { ...manifest };
  next.content_version = (Number(manifest.content_version) || 0) + 1;
  next.last_updated = today;
  for (const key of changedKeys) {
    const k = `${key}_version`;
    next[k] = (Number(manifest[k]) || 0) + 1;
  }
  return next;
}

/** Insert or replace a recipe (new ones go at the end). */
export function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const copy = [...list];
  copy[i] = item;
  return copy;
}

// ---------------------------------------------------------------- checks

const isInt = (v) => Number.isInteger(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function checkText(t, label, errors, { required = true } = {}) {
  if (t === undefined || t === null) {
    if (required) errors.push(`${label} is missing`);
    return;
  }
  if (typeof t !== 'object' || typeof t.or !== 'string' || typeof t.en !== 'string') {
    errors.push(`${label} must have Odia and English text`);
    return;
  }
  const extra = Object.keys(t).filter((k) => k !== 'or' && k !== 'en');
  if (extra.length) errors.push(`${label} has unexpected fields: ${extra.join(', ')}`);
  if (!/\S/.test(t.or) && !/\S/.test(t.en)) errors.push(`${label} is empty – write it in Odia or English`);
}

function checkImagePath(p, label, errors) {
  if (p === null || p === undefined) return;
  if (
    typeof p !== 'string' ||
    !/^images\/[a-z0-9_-]+\/[A-Za-z0-9._-]+\.(webp|jpg|jpeg|png)$/.test(p) ||
    p.includes('..')
  ) {
    errors.push(`${label}: photo path "${p}" is not valid`);
  }
}

export function recipeErrors(r) {
  const errors = [];
  const name = r?.name?.en || r?.name?.or || r?.id || 'New recipe';
  const say = (m) => errors.push(`${name}: ${m}`);
  const e = [];
  if (!r || typeof r !== 'object') return ['A recipe is not readable'];
  if (typeof r.id !== 'string' || !/^[a-z0-9_]+$/.test(r.id)) e.push('id is not valid');
  if (typeof r.slug !== 'string' || !/^[a-z0-9-]+$/.test(r.slug)) e.push('slug is not valid');
  checkText(r.name, 'name', e);
  checkText(r.description, 'description', e);
  if (typeof r.category_id !== 'string' || !r.category_id) e.push('choose a category');
  if (!['vegetarian', 'non_vegetarian'].includes(r.food_type)) e.push('choose veg or non-veg');
  if (!['easy', 'medium', 'hard'].includes(r.difficulty)) e.push('choose a difficulty');
  for (const k of ['prep_time_minutes', 'cook_time_minutes']) {
    if (!isInt(r[k]) || r[k] < 0) e.push(`${k === 'prep_time_minutes' ? 'preparation' : 'cooking'} time must be 0 or more minutes`);
  }
  if (!isInt(r.default_servings) || r.default_servings < 1) e.push('servings must be at least 1');
  checkText(r.cuisine, 'cuisine', e, { required: false });
  checkText(r.serving_suggestion, 'serving suggestion', e, { required: false });
  if (!Array.isArray(r.ingredients) || !r.ingredients.length) {
    e.push('add at least one ingredient');
  } else {
    const ids = new Set();
    r.ingredients.forEach((g, i) => {
      const n = `ingredient ${i + 1}`;
      if (!g || typeof g !== 'object') return e.push(`${n} is not readable`);
      if (typeof g.id !== 'string' || !g.id) e.push(`${n} has no id`);
      else if (ids.has(g.id)) e.push(`${n} repeats id "${g.id}"`);
      ids.add(g.id);
      checkText(g.name, `${n} name`, e);
      if (!UNIT_IDS.has(g.unit)) e.push(`${n}: choose a unit`);
      const q = g.quantity;
      if (q !== null && q !== undefined && (typeof q !== 'number' || !(q > 0) || !Number.isFinite(q))) {
        e.push(`${n}: quantity must be a number above 0`);
      }
      if ((q === null || q === undefined) && !UNMEASURED.has(g.unit)) {
        e.push(`${n}: enter a quantity, or choose "to taste" / "as required"`);
      }
      if (g.scalable !== undefined && typeof g.scalable !== 'boolean') e.push(`${n}: scalable must be yes/no`);
      checkText(g.note, `${n} note`, e, { required: false });
    });
  }
  if (!Array.isArray(r.instructions) || !r.instructions.length) {
    e.push('add at least one step');
  } else {
    r.instructions.forEach((s, i) => {
      const n = `step ${i + 1}`;
      if (!s || typeof s !== 'object') return e.push(`${n} is not readable`);
      if (!isInt(s.step) || s.step < 1) e.push(`${n} has no step number`);
      checkText(s.text, `${n} text`, e);
      const t = s.timer_seconds;
      if (t !== null && t !== undefined && (!isInt(t) || t < 1)) e.push(`${n}: timer must be whole seconds above 0`);
      checkImagePath(s.image, n, e);
      checkText(s.tip, `${n} tip`, e, { required: false });
    });
  }
  if (r.tips !== undefined) {
    if (!Array.isArray(r.tips)) e.push('tips must be a list');
    else r.tips.forEach((t, i) => checkText(t, `tip ${i + 1}`, e));
  }
  checkImagePath(r.image, 'photo', e);
  if (r.tags !== undefined && (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== 'string'))) {
    e.push('tags must be words');
  }
  for (const k of ['is_featured', 'is_published', 'is_verified']) {
    if (r[k] !== undefined && typeof r[k] !== 'boolean') e.push(`${k} must be yes/no`);
  }
  if (typeof r.published_at !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(r.published_at)) {
    e.push('published date is missing');
  }
  if (r.video !== undefined && r.video !== null) {
    const v = r.video;
    if (typeof v !== 'object') e.push('video is not readable');
    else {
      if (!/^[A-Za-z0-9_-]{11}$/.test(String(v.youtube_id))) e.push('video: the YouTube link is not valid');
      if (typeof v.credit !== 'string' || !v.credit.trim() || v.credit.length > 80) {
        e.push('video: write who made the video (up to 80 letters)');
      }
      if (v.title !== undefined && typeof v.title !== 'string') e.push('video title must be text');
      const extra = Object.keys(v).filter((k) => !['youtube_id', 'credit', 'title'].includes(k));
      if (extra.length) e.push(`video has unexpected fields: ${extra.join(', ')}`);
    }
  } else if (r.video === null) {
    e.push('video must be removed, not empty');
  }
  e.forEach(say);
  return errors;
}

export function adErrors(a, recipeIds) {
  const e = [];
  const name = a?.title?.en || a?.title?.or || a?.id || 'Ad';
  if (typeof a.id !== 'string' || !/^[a-z0-9_]+$/.test(a.id)) e.push('id is not valid');
  if (!['home_card', 'recipe'].includes(a.placement)) e.push('choose where it shows');
  if (a.placement === 'recipe' && !recipeIds.has(a.recipe_id)) e.push('choose the recipe it shows on');
  checkText(a.title, 'title', e);
  checkText(a.description, 'description', e);
  checkText(a.cta_label, 'button text', e, { required: false });
  checkImagePath(a.image, 'picture', e);
  for (const k of ['starts_on', 'ends_on']) {
    if (a[k] !== undefined && !isDate(a[k])) e.push(`${k === 'starts_on' ? 'start' : 'end'} date is not valid`);
  }
  if (a.starts_on && a.ends_on && a.ends_on < a.starts_on) e.push('end date is before the start date');
  for (const k of ['is_active', 'is_sponsored']) {
    if (a[k] !== undefined && typeof a[k] !== 'boolean') e.push(`${k} must be yes/no`);
  }
  if (a.action !== undefined) {
    const t = a.action?.type;
    const v = String(a.action?.value ?? '').trim();
    if (!['url', 'email', 'phone', 'whatsapp'].includes(t)) e.push('choose what the button does');
    if (!v) e.push('the button needs a link, email or number');
    if (t === 'url' && !v.startsWith('https://')) e.push('the link must start with https://');
    if (t === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) e.push('the email address is not valid');
    if ((t === 'phone' || t === 'whatsapp') && !/^\+?[0-9 ]{6,20}$/.test(v)) e.push('the phone number is not valid');
  }
  return e.map((m) => `Ad "${name}": ${m}`);
}

/** Every problem in a full content set; empty when phones will accept it. */
export function contentErrors({ recipes, categories, featured, advertisements, app_config }) {
  const errors = [];
  const dup = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i);

  if (!Array.isArray(categories)) errors.push('categories must be a list');
  const catIds = new Set((categories || []).map((c) => c.id));
  (categories || []).forEach((c) => {
    const e = [];
    if (typeof c.id !== 'string' || !/^[a-z0-9_]+$/.test(c.id)) e.push('id is not valid');
    checkText(c.name, 'name', e);
    checkText(c.description, 'description', e);
    if (!isInt(c.display_order)) e.push('order must be a whole number');
    checkImagePath(c.image, 'picture', e);
    e.forEach((m) => errors.push(`Category "${c?.name?.en || c?.id}": ${m}`));
  });
  dup((categories || []).map((c) => c.id)).forEach((id) => errors.push(`Two categories share the id "${id}"`));

  if (!Array.isArray(recipes)) errors.push('recipes must be a list');
  (recipes || []).forEach((r) => {
    errors.push(...recipeErrors(r));
    if (r && !catIds.has(r.category_id) && r.category_id) {
      errors.push(`${r?.name?.en || r.id}: category "${r.category_id}" does not exist`);
    }
  });
  const recipeIds = new Set((recipes || []).map((r) => r.id));
  dup((recipes || []).map((r) => r.id)).forEach((id) => errors.push(`Two recipes share the id "${id}"`));
  dup((recipes || []).map((r) => r.slug)).forEach((s) => errors.push(`Two recipes share the web name "${s}"`));

  if (!featured || typeof featured !== 'object' || Array.isArray(featured)) {
    errors.push('Home settings are not readable');
  } else {
    const live = new Set((recipes || []).filter((r) => r.is_published !== false).map((r) => r.id));
    for (const [k, label] of [['featured_recipe_id', 'Featured recipe'], ['todays_special_id', "Today's Special"]]) {
      const id = featured[k];
      if (id !== null && id !== undefined) {
        if (!recipeIds.has(id)) errors.push(`${label}: recipe "${id}" does not exist`);
        else if (!live.has(id)) errors.push(`${label}: that recipe is hidden from the app`);
      }
    }
    const pop = featured.popular_recipe_ids;
    if (pop !== undefined && !Array.isArray(pop)) errors.push('Popular list is not readable');
    (pop || []).forEach((id) => {
      if (!recipeIds.has(id)) errors.push(`Popular list: recipe "${id}" does not exist`);
    });
    dup(pop || []).forEach((id) => errors.push(`Popular list has "${id}" twice`));
  }

  if (!Array.isArray(advertisements)) errors.push('ads must be a list');
  (advertisements || []).forEach((a) => errors.push(...adErrors(a, recipeIds)));
  dup((advertisements || []).map((a) => a.id)).forEach((id) => errors.push(`Two ads share the id "${id}"`));

  if (!app_config || typeof app_config !== 'object' || Array.isArray(app_config)) {
    errors.push('Contact settings are not readable');
  } else {
    const email = app_config.contact_email;
    if (email !== null && email !== undefined && email !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push('Contact email is not valid');
    }
    for (const [k, label] of [['share_url', 'Share link'], ['privacy_policy_url', 'Privacy policy link']]) {
      const v = app_config[k];
      if (v !== null && v !== undefined && !/^https:\/\//.test(v)) errors.push(`${label} must start with https://`);
    }
  }
  return errors;
}
