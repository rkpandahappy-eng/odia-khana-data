# odia-khana-data

Recipe content for the **Odia Khana** app. The app downloads from this public
repository, so you can add or fix recipes **without publishing a new app version**.

> Never put passwords, keys or private information here – everything is public.

## Folder layout

| Path | What it is |
| --- | --- |
| `manifest.json` | Tells the app whether new content exists. |
| `data/categories.json` | Recipe categories. |
| `data/recipes.json` | All recipes (Odia + English). |
| `data/featured.json` | What Home highlights: featured recipe, Today's Special, Popular. |
| `data/advertisements.json` | The "Advertise Here" card on Home and optional sponsor cards on recipes. |
| `data/app_config.json` | Contact email, share link and privacy-policy link shown in the app. |
| `images/recipes/`, `images/categories/` | Photos for recipes added after the app release (`.webp`, ~1200 px wide, under ~200 KB). Only original or properly licensed photos. |
| `schema/` | Rules each file must follow (checked automatically). |

## How to update recipes (from the GitHub website)

1. Open the file (for example `data/recipes.json`), click the ✏️ pencil, make your change.
2. Open `manifest.json` and **increase `content_version` by 1** (for example `1` → `2`).
   Also update `last_updated`. *If you skip this step, phones will not download your change.*
3. Click **Commit changes**.
4. Open the **Actions** tab. A green ✓ means the files are valid. A red ✗ shows what to fix.
5. Phones pick up the change the next time the app checks (at most every 6 hours,
   or immediately with **Profile → Check for recipe updates**).

If a file is broken, the app **ignores the update and keeps the recipes it already has**.

### Adding a recipe

Copy an existing recipe block in `data/recipes.json` and change it. Important rules:

- `id` must be unique and **never change** once published (favourites and shopping lists use it).
- Every text needs both `"or"` (Odia) and `"en"` (English).
- `unit` is one of: `cup`, `tbsp`, `tsp`, `g`, `kg`, `ml`, `litre`, `piece`, `pinch`, `handful`,
  `to_taste`, `as_required`. Use `"quantity": null` with `to_taste` / `as_required`.
- Set `"is_verified": true` **only after** someone has checked the quantities and steps.
  Unverified recipes show a "sample recipe" notice in the app.
- To hide a recipe without deleting it, set `"is_published": false`.

### Photos

The photos of all current recipes are **built into the app**, so they show offline and are not
downloaded from here. Only photos for recipes added later need to be uploaded:

Upload to `images/recipes/` and set `"image": "images/recipes/<file>.webp"` in the recipe.
New photos load from this repository unless `manifest.json → image_base_url` points elsewhere (must be `https://`).
To replace a photo that is built into the app, upload it under a **new file name** and change
`"image"` – a photo uploaded under the old name will not show until the next app release.

## The app also ships with this data

The same files are bundled inside the app (`assets/data/`) so it works offline on first launch.
When you release a new app version, copy the latest `manifest.json` and `data/*.json` into it.

### Advertising

`data/advertisements.json` controls promotional cards. The default card invites businesses to
advertise (it emails the contact address). For a real sponsor:

- set `"is_sponsored": true` (the app then shows a **Sponsored** label, as required),
- choose `"placement": "home_card"` (Home) or `"recipe"` with a `"recipe_id"`,
- set an `"action"`: `url` (must start with `https://`), `email`, `phone` or `whatsapp`,
- optionally limit dates with `"starts_on"` / `"ends_on"` (`YYYY-MM-DD`), or switch off with `"is_active": false`.

Ads never appear inside cooking steps or as pop-ups.
