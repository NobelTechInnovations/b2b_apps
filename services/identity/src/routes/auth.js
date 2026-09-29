import { id } from '@nexus/db-kit';
import { badRequest, conflict, unauthorized, forbidden, notFound } from '@nexus/service-kit';
import { body, validate as v } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { hashPassword, verifyPassword, checkPasswordStrength, generateToken, hashToken } from '../lib/password.js';
import { signAccessToken, setAuthCookies, clearAuthCookies } from '../lib/tokens.js';
import {
  createSession, rotateSession, revokeSession, revokeAllSessions, setActiveOrg,
} from '../lib/sessions.js';

const normalizeEmail = (email) => email.trim().toLowerCase();

const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatar_url: user.avatar_url,
  phone: user.phone,
  locale: user.locale,
  timezone: user.timezone,
  email_verified: Boolean(user.email_verified_at),
  mfa_enabled: user.mfa_enabled,
  created_at: user.created_at,
});

export async function authRoutes(app) {
  const { db, config, keys, tenancy, mailer } = app;

  /** Mint an access token for a user, optionally scoped to one organization. */
  async function issue(user, { sessionId, orgId }) {
    let membership = null;
    if (orgId) {
      membership = await tenancy.membership(user.id, orgId);
      if (!membership) {
        throw forbidden('You are no longer a member of that workspace.', { code: 'membership_lost' });
      }
    }
    const accessToken = await signAccessToken({ keys, config, user, membership, sessionId });
    return { accessToken, membership };
  }

  async function recordAttempt(email, { userId, success, reason, request }) {
    await db.query(
      `INSERT INTO login_attempts (email, user_id, success, reason, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [email, userId ?? null, success, reason ?? null, request.ip, request.headers['user-agent']?.slice(0, 500) ?? null],
    );
  }

  // ══════════════════════════════════════════════════════════════ REGISTER
  app.post(
    '/auth/register',
    {
      schema: {
        body: body(
          {
            email: v.email,
            password: v.text(200, 8),
            name: v.text(120, 2),
            phone: { type: 'string', maxLength: 20, pattern: '^[+0-9 ()-]{6,20}$' },
            invitation_token: { type: 'string', maxLength: 200 },
          },
          ['email', 'password', 'name'],
        ),
      },
      config: { rateLimit: { max: config.registerPerHour, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const { password, name, invitation_token: invitationToken } = request.body;

      const strength = checkPasswordStrength(password, { email, name });
      if (!strength.ok) throw badRequest('That password is not strong enough.', strength.problems);

      const existing = await db.one(
        `SELECT id FROM users WHERE email_normalized = $1 AND status <> 'deleted'`,
        [email],
      );
      if (existing) {
        throw conflict('An account already exists for that email address.', { field: 'email' });
      }

      // If they arrived from an invitation, the email must match it — otherwise
      // anyone with a leaked link could join a workspace under any address.
      let invitation = null;
      if (invitationToken) {
        invitation = await tenancy.invitationByToken(invitationToken);
        if (!invitation) throw badRequest('That invitation link is not valid or has expired.');
        if (normalizeEmail(invitation.email) !== email) {
          throw badRequest('This invitation was sent to a different email address.');
        }
      }

      const passwordHash = await hashPassword(password);
      const verification = generateToken();

      const user = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO users (id, email, email_normalized, password_hash, name, phone)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [id('usr'), request.body.email.trim(), email, passwordHash, name.trim(), request.body.phone?.trim() || null],
        );

        await tx.query(
          `INSERT INTO email_tokens (id, user_id, purpose, token_hash, email, expires_at)
           VALUES ($1, $2, 'verify_email', $3, $4, now() + interval '48 hours')`,
          [id('emt'), created.id, verification.hash, email],
        );

        tx.emit({
          type: EVENTS.USER_REGISTERED,
          actor_id: created.id,
          data: { user_id: created.id, email, name: created.name, invited: Boolean(invitation) },
        });

        return created;
      });

      await mailer.send('verify_email', {
        to: email,
        name,
        link: `${config.appUrl}/verify-email?token=${verification.raw}`,
      });

      // An invited user joins their workspace immediately; they can verify later.
      let orgId = null;
      if (invitation) {
        const joined = await tenancy.acceptInvitation(invitationToken, user.id).catch((error) => {
          request.log.error({ err: error }, 'invitation acceptance failed after registration');
          return null;
        });
        orgId = joined?.data?.org_id ?? null;
      }

      const { session, refreshToken } = await createSession(db, {
        userId: user.id,
        orgId,
        request,
        config,
      });
      const { accessToken, membership } = await issue(user, { sessionId: session.id, orgId });

      setAuthCookies(reply, config, { accessToken, refreshToken });
      await recordAttempt(email, { userId: user.id, success: true, reason: 'register', request });

      return reply.status(201).send({
        data: {
          user: publicUser(user),
          organization: membership ? { id: membership.org_id, name: membership.org_name, slug: membership.org_slug } : null,
          needs_onboarding: !orgId,
          access_token: accessToken,
          expires_in: config.accessTokenTtl,
        },
      });
    },
  );

  // ═════════════════════════════════════════════════════════════════ LOGIN
  app.post(
    '/auth/login',
    {
      schema: {
        body: body(
          { email: v.email, password: v.text(200, 1), org_id: v.id('org') },
          ['email', 'password'],
        ),
      },
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const { password } = request.body;

      const user = await db.one(
        `SELECT * FROM users WHERE email_normalized = $1 AND status <> 'deleted'`,
        [email],
      );

      // One message for every failure mode — never reveal whether an account exists.
      const reject = async (reason) => {
        await recordAttempt(email, { userId: user?.id, success: false, reason, request });
        throw unauthorized('That email and password combination is not correct.');
      };

      if (!user) {
        await verifyPassword(password, null); // equalise timing
        return reject('no_such_user');
      }

      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        await recordAttempt(email, { userId: user.id, success: false, reason: 'locked', request });
        throw forbidden(
          `Too many failed attempts. Try again in ${Math.ceil(
            (new Date(user.locked_until) - Date.now()) / 60000,
          )} minutes.`,
          { code: 'account_locked' },
        );
      }

      if (user.status === 'suspended') {
        await recordAttempt(email, { userId: user.id, success: false, reason: 'suspended', request });
        throw forbidden('This account has been suspended. Contact your workspace owner.');
      }

      if (!(await verifyPassword(password, user.password_hash))) {
        const attempts = user.failed_attempts + 1;
        const lock = attempts >= config.maxFailedAttempts;
        await db.query(
          `UPDATE users SET failed_attempts = $2,
                  locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
            WHERE id = $1`,
          [user.id, lock ? 0 : attempts, lock, String(config.lockoutMinutes)],
        );
        return reject('bad_password');
      }

      const memberships = await tenancy.memberships(user.id);
      const requested = request.body.org_id;
      const target =
        memberships.find((m) => m.org_id === requested) ??
        memberships.find((m) => m.org_id === user.last_org_id) ??
        memberships[0] ??
        null;

      const { session, refreshToken } = await createSession(db, {
        userId: user.id,
        orgId: target?.org_id,
        request,
        config,
      });

      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE users SET failed_attempts = 0, locked_until = NULL,
                  last_login_at = now(), last_org_id = COALESCE($2, last_org_id)
            WHERE id = $1`,
          [user.id, target?.org_id ?? null],
        );
        tx.emit({
          type: EVENTS.USER_LOGGED_IN,
          org_id: target?.org_id ?? null,
          actor_id: user.id,
          data: { user_id: user.id, session_id: session.id, ip: request.ip },
        });
      });

      const { accessToken, membership } = await issue(user, {
        sessionId: session.id,
        orgId: target?.org_id,
      });

      setAuthCookies(reply, config, { accessToken, refreshToken });
      await recordAttempt(email, { userId: user.id, success: true, reason: 'password', request });

      return {
        data: {
          user: publicUser(user),
          organization: membership ? { id: membership.org_id, name: membership.org_name, slug: membership.org_slug } : null,
          organizations: memberships.map((m) => ({
            id: m.org_id,
            name: m.org_name,
            slug: m.org_slug,
            roles: m.roles,
          })),
          needs_onboarding: memberships.length === 0,
          access_token: accessToken,
          expires_in: config.accessTokenTtl,
        },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════ REFRESH
  app.post(
    '/auth/refresh',
    {
      schema: { body: body({ org_id: v.id('org'), refresh_token: { type: 'string', maxLength: 200 } }) },
      config: { rateLimit: { max: 120, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const presented = request.body?.refresh_token ?? request.cookies?.nx_rt;
      if (!presented) throw unauthorized('No session to refresh.');

      const result = await rotateSession(db, { presented, config, request });

      if (result.outcome === 'reuse_detected') {
        request.log.error(
          { family: result.familyId, user: result.userId },
          'refresh token reuse detected — all sessions in family revoked',
        );
        clearAuthCookies(reply, config);
        throw unauthorized('Your session was ended for security reasons. Please sign in again.');
      }

      if (result.outcome !== 'rotated') {
        clearAuthCookies(reply, config);
        throw unauthorized('Your session has expired. Please sign in again.');
      }

      const { session, refreshToken } = result;
      const user = await db.one(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [
        session.user_id,
      ]);
      if (!user) {
        clearAuthCookies(reply, config);
        throw unauthorized('This account is no longer active.');
      }

      // A refresh is also how a user switches workspace — and how a session
      // that predates the user's first workspace picks it up. Falling back to
      // their memberships is what makes "register → create workspace → work"
      // flow without a second sign-in.
      let targetOrg = request.body?.org_id ?? session.active_org_id;
      if (!targetOrg) {
        const memberships = await tenancy.memberships(user.id);
        targetOrg =
          memberships.find((m) => m.org_id === user.last_org_id)?.org_id ??
          memberships[0]?.org_id ??
          null;
      }

      if (targetOrg && targetOrg !== session.active_org_id) {
        await setActiveOrg(db, session.id, targetOrg);
        await db.query(`UPDATE users SET last_org_id = $2 WHERE id = $1`, [user.id, targetOrg]);
      }

      const { accessToken, membership } = await issue(user, {
        sessionId: session.id,
        orgId: targetOrg,
      });

      setAuthCookies(reply, config, { accessToken, refreshToken });

      return {
        data: {
          user: publicUser(user),
          organization: membership ? { id: membership.org_id, name: membership.org_name, slug: membership.org_slug } : null,
          access_token: accessToken,
          expires_in: config.accessTokenTtl,
        },
      };
    },
  );

  // ═════════════════════════════════════════════════════════ SWITCH WORKSPACE
  app.post(
    '/auth/switch-org',
    {
      preHandler: app.authenticate,
      schema: { body: body({ org_id: v.id('org') }, ['org_id']) },
    },
    async (request, reply) => {
      const { org_id: orgId } = request.body;
      const user = await db.one(`SELECT * FROM users WHERE id = $1`, [request.auth.userId]);

      const membership = await tenancy.membership(user.id, orgId);
      if (!membership) throw forbidden('You are not a member of that workspace.');

      await setActiveOrg(db, request.auth.sessionId, orgId);
      await db.query(`UPDATE users SET last_org_id = $2 WHERE id = $1`, [user.id, orgId]);

      const accessToken = await signAccessToken({
        keys,
        config,
        user,
        membership,
        sessionId: request.auth.sessionId,
      });
      setAuthCookies(reply, config, { accessToken });

      return {
        data: {
          organization: { id: membership.org_id, name: membership.org_name, slug: membership.org_slug },
          access_token: accessToken,
          expires_in: config.accessTokenTtl,
        },
      };
    },
  );

  // ════════════════════════════════════════════════════════════════ LOGOUT
  app.post('/auth/logout', { preHandler: app.authenticate }, async (request, reply) => {
    await revokeSession(db, request.auth.sessionId, 'signed_out');
    clearAuthCookies(reply, config);
    return { data: { signed_out: true } };
  });

  app.post('/auth/logout-all', { preHandler: app.authenticate }, async (request, reply) => {
    const count = await revokeAllSessions(db, request.auth.userId, { reason: 'signed_out_all' });
    clearAuthCookies(reply, config);
    return { data: { signed_out: true, sessions_ended: count } };
  });

  // ════════════════════════════════════════════════════════ EMAIL VERIFY
  app.post(
    '/auth/verify-email',
    { schema: { body: body({ token: v.text(200, 10) }, ['token']) } },
    async (request) => {
      const tokenHash = hashToken(request.body.token);

      const record = await db.one(
        `SELECT * FROM email_tokens
          WHERE token_hash = $1 AND purpose = 'verify_email'
            AND consumed_at IS NULL AND expires_at > now()`,
        [tokenHash],
      );
      if (!record) throw badRequest('That verification link is invalid or has expired.');

      await db.transaction(async (tx) => {
        await tx.query(`UPDATE email_tokens SET consumed_at = now() WHERE id = $1`, [record.id]);
        await tx.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [record.user_id]);
        tx.emit({
          type: EVENTS.USER_VERIFIED,
          actor_id: record.user_id,
          data: { user_id: record.user_id, email: record.email },
        });
      });

      return { data: { verified: true } };
    },
  );

  app.post(
    '/auth/resend-verification',
    { preHandler: app.authenticate, config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    async (request) => {
      const user = await db.one(`SELECT * FROM users WHERE id = $1`, [request.auth.userId]);
      if (user.email_verified_at) return { data: { sent: false, already_verified: true } };

      const token = generateToken();
      await db.query(
        `INSERT INTO email_tokens (id, user_id, purpose, token_hash, email, expires_at)
         VALUES ($1, $2, 'verify_email', $3, $4, now() + interval '48 hours')`,
        [id('emt'), user.id, token.hash, user.email_normalized],
      );
      await mailer.send('verify_email', {
        to: user.email,
        name: user.name,
        link: `${config.appUrl}/verify-email?token=${token.raw}`,
      });
      return { data: { sent: true } };
    },
  );

  // ═══════════════════════════════════════════════════════ PASSWORD RESET
  app.post(
    '/auth/forgot-password',
    {
      schema: { body: body({ email: v.email }, ['email']) },
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    },
    async (request) => {
      const email = normalizeEmail(request.body.email);
      const user = await db.one(
        `SELECT * FROM users WHERE email_normalized = $1 AND status = 'active'`,
        [email],
      );

      // Always the same answer, whether or not the account exists.
      if (user) {
        const token = generateToken();
        await db.query(
          `INSERT INTO email_tokens (id, user_id, purpose, token_hash, email, expires_at)
           VALUES ($1, $2, 'reset_password', $3, $4, now() + interval '1 hour')`,
          [id('emt'), user.id, token.hash, email],
        );
        await mailer.send('reset_password', {
          to: email,
          name: user.name,
          link: `${config.appUrl}/reset-password?token=${token.raw}`,
        });
      }

      return { data: { sent: true } };
    },
  );

  app.post(
    '/auth/reset-password',
    {
      schema: { body: body({ token: v.text(200, 10), password: v.text(200, 8) }, ['token', 'password']) },
      config: { rateLimit: { max: config.registerPerHour, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const record = await db.one(
        `SELECT t.*, u.email AS user_email, u.name AS user_name
           FROM email_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1 AND t.purpose = 'reset_password'
            AND t.consumed_at IS NULL AND t.expires_at > now()`,
        [hashToken(request.body.token)],
      );
      if (!record) throw badRequest('That reset link is invalid or has expired.');

      const strength = checkPasswordStrength(request.body.password, {
        email: record.user_email,
        name: record.user_name,
      });
      if (!strength.ok) throw badRequest('That password is not strong enough.', strength.problems);

      const passwordHash = await hashPassword(request.body.password);

      await db.transaction(async (tx) => {
        await tx.query(`UPDATE email_tokens SET consumed_at = now() WHERE id = $1`, [record.id]);
        await tx.query(
          `UPDATE users SET password_hash = $2, failed_attempts = 0, locked_until = NULL,
                  email_verified_at = COALESCE(email_verified_at, now())
            WHERE id = $1`,
          [record.user_id, passwordHash],
        );
        tx.emit({
          type: EVENTS.USER_PASSWORD_CHANGED,
          actor_id: record.user_id,
          data: { user_id: record.user_id, via: 'reset' },
        });
      });

      // A password reset invalidates every existing session. That is the point.
      await revokeAllSessions(db, record.user_id, { reason: 'password_reset' });
      clearAuthCookies(reply, config);

      return { data: { reset: true } };
    },
  );

  app.post(
    '/auth/change-password',
    {
      preHandler: app.authenticate,
      schema: {
        body: body(
          { current_password: v.text(200, 1), new_password: v.text(200, 8) },
          ['current_password', 'new_password'],
        ),
      },
    },
    async (request) => {
      const user = await db.one(`SELECT * FROM users WHERE id = $1`, [request.auth.userId]);
      if (!(await verifyPassword(request.body.current_password, user.password_hash))) {
        throw unauthorized('Your current password is not correct.');
      }

      const strength = checkPasswordStrength(request.body.new_password, {
        email: user.email,
        name: user.name,
      });
      if (!strength.ok) throw badRequest('That password is not strong enough.', strength.problems);

      await db.transaction(async (tx) => {
        await tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
          user.id,
          await hashPassword(request.body.new_password),
        ]);
        tx.emit({
          type: EVENTS.USER_PASSWORD_CHANGED,
          actor_id: user.id,
          data: { user_id: user.id, via: 'self_service' },
        });
      });

      // Keep this device signed in, drop every other one.
      const ended = await revokeAllSessions(db, user.id, {
        except: request.auth.sessionId,
        reason: 'password_changed',
      });

      return { data: { changed: true, other_sessions_ended: ended } };
    },
  );

  // ═════════════════════════════════════════════════════════════════════ ME
  app.get('/auth/me', { preHandler: app.authenticate }, async (request) => {
    const user = await db.one(`SELECT * FROM users WHERE id = $1 AND status <> 'deleted'`, [
      request.auth.userId,
    ]);
    if (!user) throw notFound('User');

    const memberships = await tenancy.memberships(user.id);

    return {
      data: {
        user: publicUser(user),
        organizations: memberships.map((m) => ({
          id: m.org_id,
          name: m.org_name,
          slug: m.org_slug,
          logo_url: m.org_logo_url,
          roles: m.roles,
        })),
        active_org_id: request.auth.orgId,
        session_id: request.auth.sessionId,
      },
    };
  });
}
