// Create operator accounts AND add them to the operators allowlist.
// Run on YOUR machine only (never in CI, never in the browser): it needs the service key.
//
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=... \
//     node scripts/create-operators.mjs op1@lab.edu op2@lab.edu
//
// Prints a random password per new account, once. Re-running is safe: existing accounts are
// kept and only the allowlist row is ensured.
import { randomBytes } from 'node:crypto';

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const svc = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const emails = process.argv.slice(2).map(e => e.trim().toLowerCase()).filter(Boolean);
if (!url || !svc || !emails.length) {
  console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/create-operators.mjs <email> [<email> ...]');
  process.exit(1);
}
const H = { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' };

for (const email of emails) {
  const password = randomBytes(12).toString('base64url');
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST', headers: H, body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) console.log(`created  ${email}   password: ${password}`);
  else if (res.status === 422 || /already/i.test(JSON.stringify(body))) console.log(`exists   ${email}   (password unchanged; reset it in Dashboard > Authentication > Users)`);
  else { console.error(`FAILED   ${email}  HTTP ${res.status} ${JSON.stringify(body)}`); continue; }

  const r2 = await fetch(`${url}/rest/v1/operators`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ email }),
  });
  console.log(r2.ok ? `allowlisted ${email}` : `ALLOWLIST FAILED ${email}: HTTP ${r2.status} ${await r2.text()}`);
}
console.log('\nStore the passwords somewhere safe; they are not shown again.');
