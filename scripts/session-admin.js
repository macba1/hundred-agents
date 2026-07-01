/* ============================================================
   Session admin CLI (operator tool, not a web route).
   Connects to the discovery store via REDIS_URL and can:
     list                       — summarize all gabi sessions
     mark-test  --token X | --email Y  --reason "..." --by "..."
     purge-test --token X | --email Y  --confirm

   Safety:
   - purge-test requires --confirm AND an exact token/email filter,
     AND only deletes sessions where metadata.is_test === true.
     It never touches real sessions.
   - No global "delete all". No fuzzy matching.

   Usage: REDIS_URL=... node scripts/session-admin.js <cmd> [flags]
   ============================================================ */
const PREFIX = 'disc:gabi:';

function emailOf(s) {
  return (s.brainPartial && s.brainPartial.client_contact && s.brainPartial.client_contact.email)
      || (s.artifacts && s.artifacts.brain && s.artifacts.brain.client_contact && s.artifacts.brain.client_contact.email)
      || null;
}
function isTest(s) { return !!(s && s.metadata && s.metadata.is_test === true); }
function matches(s, f) {
  if (f.token) return s.sessionToken === f.token;
  if (f.email) return emailOf(s) === f.email;
  return false;
}
/** Pure: only is_test sessions matching an EXACT token/email filter. */
function selectForPurge(sessions, f) {
  if (!f || (!f.token && !f.email)) return [];
  return sessions.filter((s) => isTest(s) && matches(s, f));
}

module.exports = { emailOf, isTest, matches, selectForPurge };

// ---- CLI (only when run directly) ----
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
  const RU = process.env.REDIS_URL;
  if (!RU) { console.error('REDIS_URL required'); process.exit(1); }
  const { createClient } = require('redis');

  (async () => {
    const c = createClient({ url: RU }); c.on('error', () => {}); await c.connect();
    const keys = await c.keys(PREFIX + '*');
    const all = [];
    for (const k of keys) { try { all.push(JSON.parse(await c.get(k))); } catch {} }

    if (cmd === 'list') {
      const real = all.filter((s) => !isTest(s)), test = all.filter(isTest);
      const row = (s) => `  ${s.sessionToken.slice(0, 8)}… | ${s.status} | ${emailOf(s) || '(none)'} | msgs:${(s.transcript || []).length}${isTest(s) ? ' | TEST(' + (s.metadata.test_reason || '') + ')' : ''}`;
      console.log(`REAL sessions (${real.length}):`); real.forEach((s) => console.log(row(s)));
      console.log(`TEST sessions (${test.length}):`); test.forEach((s) => console.log(row(s)));
    } else if (cmd === 'mark-test') {
      const f = { token: flag('token'), email: flag('email') };
      const target = all.find((s) => matches(s, f));
      if (!target) { console.error('no session matched', f); process.exit(2); }
      target.metadata = Object.assign({}, target.metadata, {
        is_test: true,
        test_reason: flag('reason') || 'Internal test',
        marked_by: flag('by') || 'operator',
        marked_at: new Date().toISOString(),
      });
      await c.set(PREFIX + target.sessionToken, JSON.stringify(target));
      console.log('marked test:', target.sessionToken.slice(0, 8) + '…', '| email:', emailOf(target), '|', JSON.stringify(target.metadata));
    } else if (cmd === 'purge-test') {
      const f = { token: flag('token'), email: flag('email') };
      const victims = selectForPurge(all, f);
      if (!victims.length) { console.error('nothing to purge (need is_test:true + exact --token/--email match)'); process.exit(2); }
      console.log('WOULD purge:', victims.map((s) => s.sessionToken.slice(0, 8) + '… (' + emailOf(s) + ')').join(', '));
      if (flag('confirm') !== true) { console.error('refusing: pass --confirm to actually delete'); process.exit(3); }
      for (const s of victims) await c.del(PREFIX + s.sessionToken);
      console.log('purged', victims.length, 'test session(s)');
    } else {
      console.error('commands: list | mark-test --token|--email --reason --by | purge-test --token|--email --confirm');
      process.exit(1);
    }
    await c.quit();
  })().catch((e) => { console.error('ERR', e.code || e.message); process.exit(1); });
}
