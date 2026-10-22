/**
 * S1 regression suite — initial-password exposure and the forced first-login
 * change (User.mustChangePassword).
 *
 * Three properties are asserted against the real API, not the source:
 *   1. No response the backend produces — for any role, on any endpoint a
 *      staff member can reach — carries a `password` or `passwordHash` field,
 *      and no response other than the account-creating one ever states the
 *      derivation rule.
 *   2. A login provisioned from the guardian contact may sign in but cannot
 *      reach a single business endpoint until it changes its password.
 *   3. The change actually ends the exposure: the old (predictable) password
 *      stops working, and the same value is refused as the replacement.
 *
 * Node built-in test runner, zero extra deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

/** Every object key anywhere in a parsed body, so nothing nested slips by. */
function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((v) => allKeys(v, out));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => {
      out.add(k);
      allKeys(v, out);
    });
  }
  return out;
}

/** Assert a response body carries no credential field of any kind. */
function assertNoCredentialFields(body, where) {
  const keys = allKeys(body);
  for (const forbidden of ['password', 'passwordHash', 'hash', 'secret']) {
    assert.ok(!keys.has(forbidden), `${where} leaked a "${forbidden}" field: ${JSON.stringify(body)}`);
  }
}

/** Top-level `code` from a sendError / sendValidationError body. */
const codeOf = (body) => body.code;

test('S1: no password ever comes back from the API, and the initial one is forced out', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');
  assert.equal(admin.user.mustChangePassword, false, 'a seeded account must not be forced to change');

  /* ---------- 1. staff-readable endpoints carry no credential field ---------- */

  await t.test('staff list/me/overview responses contain no password field', async () => {
    const endpoints = [
      '/admin/students',
      '/admin/users',
      '/admin/employees',
      '/auth/me',
      '/admin/class-management/overview',
    ];
    for (const path of endpoints) {
      const res = await request(base, path, { token: admin.accessToken });
      assert.equal(res.status, 200, `${path} should be readable by an admin — got ${res.status}`);
      assertNoCredentialFields(res.body, `GET ${path}`);
    }
  });

  /* ---------- 2. a derived login can sign in, but can go nowhere ---------- */

  let kid;
  let kidLogin;

  await t.test('a student account created from a guardian contact is flagged', async () => {
    const created = await request(base, '/admin/students', {
      method: 'POST',
      token: admin.accessToken,
      body: {
        name: 'Forced Change Kid', class: '7', section: 'A',
        parentName: 'Forced Change Guardian', guardianContact: '+91-9111111111',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    kid = created.body.data;
    assert.equal(kid.account.username, 'forced.change.kid');
    // The one-time allowance: the create response states the rule so the admin
    // can hand the login over — and says plainly that this is the only time.
    assert.ok(created.body.message.includes('initial password = guardian contact'));
    assert.ok(created.body.message.includes('cannot be retrieved afterwards'));

    kidLogin = await login(base, 'forced.change.kid', '+91-9111111111');
    assert.equal(kidLogin.user.mustChangePassword, true,
      'a login derived from the guardian contact must be forced to change it');
  });

  await t.test('the student profile read carries no password field or rule', async () => {
    const res = await request(base, `/students/${kid.id}/profile`, { token: admin.accessToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assertNoCredentialFields(res.body, 'GET /students/:id/profile');
    // The derivation rule lives only in the account-creating response — a
    // profile read (which any staff role may perform) must never restate it.
    assert.ok(
      !JSON.stringify(res.body).toLowerCase().includes('initial password'),
      'the profile must not state where the initial password comes from',
    );
    assert.equal(res.body.data.username, 'forced.change.kid');
  });

  await t.test('the flagged account is refused every business endpoint', async () => {
    const token = kidLogin.accessToken;
    const gated = [
      '/admin/students',
      `/students/${kid.id}/profile`,
      `/students/${kid.id}/attendance`,
      '/admin/class-management/overview',
      '/admin/employees',
      '/admin/users',
    ];
    for (const path of gated) {
      const res = await request(base, path, { token });
      assert.equal(res.status, 403, `${path} should be gated for a forced-change account — got ${res.status}`);
      assert.equal(codeOf(res.body), 'PASSWORD_CHANGE_REQUIRED',
        `${path} should explain the gate: ${JSON.stringify(res.body)}`);
      assertNoCredentialFields(res.body, `GET ${path}`);
    }

    // /auth/* stays open on purpose — it is the only way out of this state.
    const me = await request(base, '/auth/me', { token });
    assert.equal(me.status, 200, '/auth/me must remain reachable so the portal can render the change screen');
    assert.equal(me.body.data.mustChangePassword, true);
    assertNoCredentialFields(me.body, 'GET /auth/me');
  });

  await t.test('change-password refuses a bad current password and the predictable replacement', async () => {
    const token = kidLogin.accessToken;

    const wrongCurrent = await request(base, '/auth/change-password', {
      method: 'POST',
      token,
      body: { currentPassword: 'NotTheContact@1', newPassword: 'Changed@123' },
    });
    assert.equal(wrongCurrent.status, 400, JSON.stringify(wrongCurrent.body));
    assert.equal(codeOf(wrongCurrent.body), 'CURRENT_PASSWORD_INVALID');

    // Re-submitting the guardian contact would clear the flag while leaving
    // the credential exactly as predictable as it was — refused.
    const reuse = await request(base, '/auth/change-password', {
      method: 'POST',
      token,
      body: { currentPassword: '+91-9111111111', newPassword: '+91-9111111111' },
    });
    assert.equal(reuse.status, 400, JSON.stringify(reuse.body));
    assert.equal(codeOf(reuse.body), 'PASSWORD_REUSE_DEFAULT');

    // Complexity rule matches the admin reset, server-side.
    const weak = await request(base, '/auth/change-password', {
      method: 'POST',
      token,
      body: { currentPassword: '+91-9111111111', newPassword: 'short' },
    });
    assert.equal(weak.status, 400, JSON.stringify(weak.body));
    assert.equal(codeOf(weak.body), 'VALIDATION_ERROR');

    // Still gated: none of the attempts cleared the flag.
    const still = await request(base, '/admin/students', { token });
    assert.equal(still.status, 403);
  });

  await t.test('a real change unblocks the account and kills the predictable password', async () => {
    const changed = await request(base, '/auth/change-password', {
      method: 'POST',
      token: kidLogin.accessToken,
      body: { currentPassword: '+91-9111111111', newPassword: 'Chosen@2026' },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assertNoCredentialFields(changed.body, 'POST /auth/change-password');
    assert.equal(changed.body.data.user.mustChangePassword, false);
    assert.ok(changed.body.data.accessToken, 'a refreshed token must be issued so the portal unblocks at once');

    // The new token (flag cleared) reaches business endpoints the student's
    // own role is allowed to read...
    const unlocked = await request(base, `/students/${kid.id}/profile`, { token: changed.body.data.accessToken });
    assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
    assertNoCredentialFields(unlocked.body, 'GET /students/:id/profile');

    // ...while the guardian contact is no longer a valid password at all.
    const relogin = await request(base, '/auth/login', {
      method: 'POST',
      body: { username: 'forced.change.kid', password: '+91-9111111111' },
    });
    assert.equal(relogin.status, 401, 'the guardian contact must no longer be a valid password');

    const withNew = await login(base, 'forced.change.kid', 'Chosen@2026');
    assert.equal(withNew.user.mustChangePassword, false, 'the flag must not come back on the next login');
    const business = await request(base, `/students/${kid.id}/profile`, { token: withNew.accessToken });
    assert.equal(business.status, 200);
    assertNoCredentialFields(business.body, 'GET /students/:id/profile');
  });

  /* ---------- 3. an admin-set password is a deliberate choice, not a default ---------- */

  await t.test('an admin reset does not force a change', async () => {
    const list = await request(base, '/admin/users', { token: admin.accessToken });
    const target = list.body.data.find((u) => u.role === 'student');
    assert.ok(target, 'the seed must contain a student user to reset');

    const reset = await request(base, `/admin/users/${target.id}/reset-password`, {
      method: 'PUT',
      token: admin.accessToken,
      body: { newPassword: 'Reset@1234' },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assertNoCredentialFields(reset.body, 'PUT /admin/users/:id/reset-password');

    const asTarget = await login(base, target.username, 'Reset@1234');
    assert.equal(asTarget.user.mustChangePassword, false,
      'a password the admin chose deliberately must not trigger the forced change');
    const me = await request(base, '/auth/me', { token: asTarget.accessToken });
    assert.equal(me.status, 200);
    assertNoCredentialFields(me.body, 'GET /auth/me');
  });

  await stopServer(server);
});
