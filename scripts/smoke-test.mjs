// Post-deploy security + health check, run as an anonymous visitor.
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/smoke-test.mjs
// Exit code 1 if anything is misconfigured (CI fails the deploy job).
const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY'); process.exit(1); }

const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
let failed = 0;
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failed++;
};
const call = async (path, opts = {}) => {
  const res = await fetch(url + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  let body = null; try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
};

// 1. Public mirror readable, contains no personal data
const pub = await call('/rest/v1/public_samples?select=*&limit=50');
check(pub.status === 200 && Array.isArray(pub.body), 'anon can read public_samples', `HTTP ${pub.status}`);
if (Array.isArray(pub.body) && pub.body.length) {
  const keys = Object.keys(pub.body[0]);
  check(!keys.includes('student_name') && !keys.includes('roll_no'), 'public_samples exposes no full name / roll number');
  check(pub.body.every(r => /^\*{3}/.test(r.roll_masked)), 'roll numbers are masked');
}

// 2. Full table is closed to anonymous users
const full = await call('/rest/v1/samples?select=*&limit=1');
check(full.status >= 400 || (Array.isArray(full.body) && full.body.length === 0), 'anon cannot read samples', `HTTP ${full.status}`);

// 3. Anonymous writes are rejected
const ins = await call('/rest/v1/samples', { method: 'POST',
  body: JSON.stringify({ student_name: 'smoke', roll_no: '000', sample_label: 'SMOKE', est_minutes: 1 }) });
check(ins.status >= 400, 'anon cannot insert into samples', `HTTP ${ins.status}`);
const upd = await call('/rest/v1/public_samples?status=eq.queued', { method: 'PATCH', body: JSON.stringify({ status: 'ready' }) });
check(upd.status >= 400, 'anon cannot update public_samples', `HTTP ${upd.status}`);
const del = await call('/rest/v1/public_samples?status=eq.queued', { method: 'DELETE' });
check(del.status >= 400, 'anon cannot delete from public_samples', `HTTP ${del.status}`);

// 4. Operator allowlist is not exposed
const ops = await call('/rest/v1/operators?select=*');
check(ops.status >= 400 || (Array.isArray(ops.body) && ops.body.length === 0), 'anon cannot read operators', `HTTP ${ops.status}`);

// 5. Server clock RPC works (used for ETA accuracy)
const now = await call('/rest/v1/rpc/server_now', { method: 'POST', body: '{}' });
check(now.status === 200, 'server_now() reachable', `HTTP ${now.status}`);

// 6. Public sign-ups must be off
const settings = await call('/auth/v1/settings');
check(settings.body && settings.body.disable_signup === true, 'public sign-ups are disabled',
  settings.body ? `disable_signup=${settings.body.disable_signup}` : `HTTP ${settings.status}`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
