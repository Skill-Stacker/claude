// Wires the profile CRUD, PIN and lock routes onto the app server. All the
// real logic (hashing, lockout timing, secrets on disk, in-memory unlock
// sessions) lives in profiles.js; this file is only the HTTP shape around
// it, plus the SSE 'lock' events and the 'profile' status provider.
//
// Usage:
//   import { wireProfiles } from './profile-routes.js';
//   wireProfiles(app, { db, paths, lockManager, bus });

import {
  listProfiles,
  getProfile,
  createProfile,
  hasPin,
  setPin,
  verifyPin,
  promoteToAdult,
  hasGoogleConnected,
  ensureProfileDirs,
} from './profiles.js';

const NAME_MAX = 40;

function toApiProfile(paths, lockManager, profile) {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    hasPin: hasPin(profile),
    googleConnected: hasGoogleConnected(paths.profiles, profile),
    unlockedUntil: lockManager.unlockedUntil(profile.id),
  };
}

// Accepts a query-string value or a JSON body value; both arrive as
// whatever JSON.parse or URLSearchParams handed back, so this is the one
// place that turns that into a real profile id or null.
function parseProfileId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

function pinFailure(check) {
  return {
    ok: false,
    lockedForSeconds: check.lockedForSeconds,
    message: check.lockedForSeconds ? `Try again in ${check.lockedForSeconds} seconds.` : 'That pin is not right.',
  };
}

export function wireProfiles(app, { db, paths, lockManager, bus }) {
  function requireProfile(ctx, profileId) {
    const profile = getProfile(db, profileId);
    if (!profile) {
      ctx.sendJson(404, { error: 'not_found', message: 'No profile with that id.' });
      return null;
    }
    return profile;
  }

  function requireProfileId(ctx, raw) {
    const profileId = parseProfileId(raw);
    if (profileId == null) {
      ctx.sendJson(400, { error: 'bad_request', message: 'profileId is required.' });
      return null;
    }
    return profileId;
  }

  function publishLock(profileId, unlockedUntil) {
    if (bus) bus.publish('lock', { profileId, unlockedUntil });
  }

  // ---------------------------------------------------------------------

  app.addRoute('GET', '/api/profiles', (req, res, ctx) => {
    const profiles = listProfiles(db).map((p) => toApiProfile(paths, lockManager, p));
    ctx.sendJson(200, { profiles });
  });

  app.addRoute('POST', '/api/profiles', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const name = String(body.name || '').trim();
    if (!name || name.length > NAME_MAX) {
      return ctx.sendJson(400, { error: 'bad_name', message: `Name must be 1 to ${NAME_MAX} characters.` });
    }
    const profile = createProfile(db, { name, kind: 'child' });
    ensureProfileDirs(paths.profiles, profile);
    ctx.sendJson(200, { profile: toApiProfile(paths, lockManager, profile) });
  });

  app.addRoute('POST', '/api/profiles/pin', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;

    if (!hasPin(profile)) {
      try {
        setPin(db, profileId, body.pin);
      } catch (err) {
        return ctx.sendJson(400, { error: 'bad_pin', message: err.message });
      }
      return ctx.sendJson(200, { ok: true });
    }

    const check = verifyPin(db, profileId, body.pin);
    if (!check.ok) return ctx.sendJson(200, pinFailure(check));

    if (!body.newPin) {
      return ctx.sendJson(400, { error: 'missing_newPin', message: 'Enter a new pin to change it.' });
    }
    try {
      setPin(db, profileId, body.newPin);
    } catch (err) {
      return ctx.sendJson(400, { error: 'bad_pin', message: err.message });
    }
    ctx.sendJson(200, { ok: true });
  });

  app.addRoute('POST', '/api/profiles/unlock', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;

    if (!hasPin(profile)) {
      return ctx.sendJson(400, { error: 'no_pin', message: 'This profile has no pin set.' });
    }

    const check = verifyPin(db, profileId, body.pin);
    if (!check.ok) return ctx.sendJson(200, pinFailure(check));

    const until = lockManager.unlock(profileId, profile.auto_lock_minutes);
    lockManager.markFreshPin(profileId);
    publishLock(profileId, until);
    ctx.sendJson(200, { ok: true, unlockedUntil: until });
  });

  app.addRoute('POST', '/api/profiles/lock', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;

    lockManager.lock(profileId);
    publishLock(profileId, null);
    ctx.sendJson(200, { ok: true });
  });

  app.addRoute('POST', '/api/profiles/promote', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;

    if (!hasPin(profile)) {
      return ctx.sendJson(409, {
        error: 'no_pin',
        message: 'Set a pin for this profile before making it an adult profile.',
      });
    }

    const check = verifyPin(db, profileId, body.pin);
    if (!check.ok) return ctx.sendJson(200, pinFailure(check));

    const updated = promoteToAdult(db, profileId);
    ctx.sendJson(200, { ok: true, profile: toApiProfile(paths, lockManager, updated) });
  });

  app.setStatus('profile', () => {
    const profiles = listProfiles(db);
    return {
      count: profiles.length,
      unlocked: profiles.filter((p) => lockManager.isUnlocked(p.id)).map((p) => p.id),
    };
  });
}
