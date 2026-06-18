# wezut/ — demo image set

Sibling of `app/`. The app's **Demo set** button fetches `../wezut/index.json`
and loads the images it lists.

## Populate
1. Drop the WEZUT document photos into this folder.
2. From `lab/`, regenerate the manifest:
   ```sh
   node app/make-manifest.mjs wezut
   ```
3. Reload the app and click **Demo set**.

Caveats: static-host size limits (GitHub Pages ~1 GB, 100 MB/file) and the WEZUT
redistribution license. For large sets, host images on a CDN and set `"base"` to
the absolute URL in `index.json` (CORS must allow it).
