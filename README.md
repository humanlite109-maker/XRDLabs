# Sample Queue & Tracking System

Static web app (`web/index.html`) + Supabase (Auth, Postgres, Realtime). Students watch their sample on a phone via QR code, no login. Two operators run the queue.

## What is in the repo

- `web/index.html`: the whole app (student view, operator view `#operator`, ETA engine, QR code, CSV export).
- `supabase/migrations/20261105000000_init.sql`: tables, RLS, triggers, realtime. Idempotent.
- `scripts/build.mjs`: copies `web/` to `dist/` and injects `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Refuses secret/service keys.
- `scripts/create-operators.mjs`: creates operator accounts and adds them to the allowlist (run locally).
- `scripts/smoke-test.mjs`: anonymous-visitor security check against the live backend.
- `.github/workflows/`: `deploy.yml` (build, publish to Pages, smoke test), `db-migrate.yml` (optional CLI migrations), `keepalive.yml` (prevents free-tier pause).
- `netlify.toml`: alternative to GitHub Pages.

## How the data is protected

- `samples` (full names, roll numbers) is readable and writable only by allowlisted operators. No delete grant, so history is permanent.
- `public_samples` is a trigger-maintained mirror with first name, sample label and masked roll (`***456`). Students read only this table, and only it is streamed to them over Realtime.
- A `BEFORE` trigger sets every timestamp and operator identity on the server, ignores client-supplied values, and allows only `queued → running → ready → collected`.
- The operator buttons also send `WHERE status = <previous>`, so if both operators tap the same sample, one wins and the other is told to refresh.
- The `anon` key in the page source is public by design. RLS is the protection. `smoke-test.mjs` proves it after every deploy.

## Deploy, start to finish

### 1. Create the Supabase project
- supabase.com → New project (free tier). Save the database password.
- Project Settings → API: copy the **Project URL** and the **publishable key** (`sb_publishable_…`) or legacy **anon public** key. Never use the secret/service key in the site.

### 2. Create the database
- Option A (simplest): Dashboard → SQL Editor → paste `supabase/migrations/20261105000000_init.sql` → Run.
- Option B (automated): add the `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` and `SUPABASE_PROJECT_REF` repo secrets; `db-migrate.yml` applies new migrations on push.

### 3. Lock down sign-ups (cannot be done in SQL)
- Dashboard → Authentication → Sign In / Providers → turn **off** "Allow new users to sign up".
- Even if this is left on, strangers cannot read or write samples (allowlist), but turn it off anyway.

### 4. Create the two operator accounts
- Run on your own computer (needs Node 18+), using the **service** key from the API settings page:
  ```
  export SUPABASE_URL=https://YOUR-REF.supabase.co
  export SUPABASE_SERVICE_KEY=...
  node scripts/create-operators.mjs op1@lab.edu op2@lab.edu
  ```
- It prints one random password per account, once. Use real addresses; replace the examples.
- Passwords can be reset later in Dashboard → Authentication → Users.

### 5. Test locally
- ```
  export SUPABASE_URL=...  SUPABASE_ANON_KEY=...
  npm run serve        # http://localhost:8080  (student)  and  /#operator
  ```
- Sign in at `/#operator`, add a sample, walk it through Start → Ready → Collected, and watch a second browser tab (student view) update live.

### 6. Publish with GitHub Pages
- Push this folder to a new GitHub repo (branch `main`).
- Repo → Settings → Secrets and variables → Actions → add `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- Repo → Settings → Pages → Source: **GitHub Actions**.
- Push, or Actions → "Deploy site" → Run workflow. The `smoke` job must pass (green).
- The site is at `https://<user>.github.io/<repo>/`. Operators use `…/#operator`.

#### Netlify instead
- New site from Git → build settings are read from `netlify.toml` → add `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment variables → deploy.

### 7. Go live in the lab
- Open the site → `/#operator` → sign in → **Student QR** → print or display the QR. Students scan it; no login.
- Operators stay signed in on their devices (session cached and auto-refreshed).
- Set `MACHINE_SLOTS` at the top of the script in `index.html` if the machine runs more than one sample at once (default 1).

## Day-to-day operation

- Add sample → ▶ Start → ✅ Ready → 📦 Collected. ✎ changes a sample's run time.
- History tab: search everything, including who did each step. **Export CSV** downloads all records (Excel-safe, formula-injection-safe).
- ETA: remaining time of what is running plus run minutes of everything ahead in the queue. Browsers correct their own clock using the server clock.

## Operations and limits

- **Free-tier pause:** the keep-alive workflow reads one row every 3 days. GitHub disables scheduled workflows after 60 days without commits; re-enable it in the Actions tab if that happens.
- **Realtime:** anonymous Realtime connections are time-limited by Supabase; students' pages also refresh every 30 s and when the tab regains focus, so nothing goes stale.
- **Backups:** export the CSV at the end of each term. Archive or delete old rows from the SQL Editor if you approach free-tier limits.
- **Changing the masking or what students see:** edit `mask_roll()` and `sync_public_samples()` in a new migration file.
- **Adding or removing an operator later:** `node scripts/create-operators.mjs new@lab.edu`; to remove, delete the row from `operators` (and the user in Auth).

## Troubleshooting

- "Setup needed" banner: the build was not run, or the secrets are missing.
- Live dot stays red: check the table is in the `supabase_realtime` publication (the migration does this) and the URL/key are for the same project.
- Operator sees "Not authorised": the email is not in `operators`. Re-run `create-operators.mjs` for it.
- Smoke test fails on "sign-ups disabled": do step 3.
