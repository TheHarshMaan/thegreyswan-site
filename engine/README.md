# The Grey Swan Engine

A small Cloudflare Worker between thegreyswan.in and OpenAlex. It holds The Grey Swan's OpenAlex API key (so visitors
don't need their own) and keeps answers for a day (so repeat searches are fast). It never sees manuscripts: only the
same search terms that would otherwise go straight from the visitor's browser to OpenAlex.

Until it is set up, the site works exactly as before: `assets/engine.js` is empty, and the tools ask OpenAlex directly.

## Set it up (about 15 minutes, free, no command line)

1. **Get an OpenAlex API key** (free): sign in at openalex.org, then open <https://openalex.org/settings/api> and copy
   the key.
2. **Create a Cloudflare account** (free) at <https://dash.cloudflare.com/sign-up>.
3. In the Cloudflare dashboard: **Workers & Pages → Create → Create Worker**. Name it `grey-swan-engine` and click
   **Deploy** (it deploys a "Hello World" first).
4. Click **Edit code**. Delete everything in the editor, paste in the whole of `worker.js` from this folder, and click
   **Deploy**.
5. Go back to the worker and open **Settings → Variables and Secrets**. Add:
   - `OPENALEX_KEY`: type **Secret**, value: your OpenAlex key
   - `ALLOWED_ORIGINS`: type **Text**, value: `https://thegreyswan.in,https://www.thegreyswan.in`
   - `CONTACT_EMAIL`: type **Text**, value: `editorial@thegreyswan.in`

   Click **Deploy** again so the settings take effect.
6. Copy the worker's address from its overview page (it looks like `https://grey-swan-engine.<your-name>.workers.dev`).
   Open `<that address>/health` in your browser: it should show `{"ok":true,"key":true}`.
7. In this repository, open `assets/engine.js` and put the address between the quotes:

   ```js
   window.GS_ENGINE = "https://grey-swan-engine.<your-name>.workers.dev";
   ```

   Commit. From then on, Find reviewers and Check conflicts ask OpenAlex through the engine.

## Good to know

- **Cost:** Cloudflare's free plan covers a large number of requests a day, far more than the site uses now.
- **Switching it off:** empty the quotes in `assets/engine.js` again; the tools go straight back to OpenAlex.
- **Safety:** it answers only GET requests from thegreyswan.in, and only for api.openalex.org, so nobody can use it
  as a general proxy or to spend your OpenAlex allowance from their own site.
- **The key** lives only in Cloudflare's secret store, never in this public repository.
- `wrangler.toml` is there in case a developer prefers to deploy it with Cloudflare's command-line tool
  (`npx wrangler deploy`, then `npx wrangler secret put OPENALEX_KEY`).
