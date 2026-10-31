# Deploying to Cloudflare Pages

The app is a static site: the report calculations run in each user's browser, so uploaded Excel files never leave their PC. The only thing stored in Cloudflare is the shared state (month-to-date history, remembered Category Review choices, verification history and expected report columns), in a KV namespace.

## One-time setup

Run these from the `kochi-pages-app` folder.

1. **Install** (needs Node.js and Python):
   ```
   npm run setup
   ```
2. **Log in to Cloudflare** (opens a browser):
   ```
   npx wrangler login
   ```
3. **Create the KV namespace for shared state:**
   ```
   npx wrangler kv namespace create STATE
   ```
   Copy the `id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.
4. **Deploy:**
   ```
   npm run deploy
   ```
   The first time, wrangler asks to create the Pages project (`kochi-his-report`). It then prints the site URL, `https://kochi-his-report.pages.dev`.
5. **Restrict access (important).** Without this, anyone who finds the URL can open the app and change the shared history.
   1. In the Cloudflare dashboard, go to **Workers & Pages → kochi-his-report → Settings → General → Access policy**, and enable it.
   2. Alternatively, go to **Zero Trust → Access → Applications → Add an application → Self-hosted**, and set the domain to `kochi-his-report.pages.dev`.
   3. Add a policy that allows only the staff email addresses (for example the `@amritapharmacy.com` domain), using one-time PIN login. This is free for up to 50 users.
   4. Make sure **both** the production domain and preview deployments (`*.kochi-his-report.pages.dev`) are covered.

## Updating

After any code change:
```
npm run deploy
```
Shared state in KV is untouched by deploys.

## Running locally before deploying

```
npm run dev
```
This opens http://127.0.0.1:8788 with a **local** KV, stored in `.wrangler/`. Delete that folder for a clean start.

## Good to know

- **First visit on a PC** downloads about 20 MB (the Python engine and pandas, from cdn.jsdelivr.net). It takes up to about a minute on a slow connection. The browser caches it, so later visits take a few seconds.
- **Office firewall:** the PCs need access to `cdn.jsdelivr.net` (the Python engine), `files.pythonhosted.org` and `pypi.org` (openpyxl, fetched on load).
- **One run at a time.** If two PCs process reports at exactly the same moment, the last one to save wins for the shared history. Process the daily report from one PC at a time.
- **Delay between PCs:** KV changes can take up to about 60 seconds to show on another PC.
- **Seeding:** until something has been saved, the shipped files in `config/` and `backend/data/` are used as the starting history. That includes one sample day, 18 June 2026. To start with empty history, create the KV entries yourself:
  ```
  npx wrangler kv key put --binding STATE --remote daily_history.json "{}"
  npx wrangler kv key put --binding STATE --remote verification_history.json "{}"
  ```
