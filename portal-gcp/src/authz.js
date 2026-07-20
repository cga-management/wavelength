// Authorization, enforced SERVER-SIDE per request, keyed on the identity resolved by
// resolveIdentity - never on anything the client asserts (docs/portal.md, "Authorization,
// action by action"). "App admin" is a per-app relationship, not a global tier.
//
// The 16-row table:
//   View deployed app cards                         User / AppAdmin / PlatformAdmin
//   View a pending (registered) card                owner only / AppAdmin(own) / PlatformAdmin
//   Open an app                                      all
//   Register an app                                  all authenticated
//   Edit app metadata                                AppAdmin / PlatformAdmin
//   First deploy (approve/publish)                   PlatformAdmin ONLY (AppAdmin: no)
//   Redeploy (after first deploy)                    AppAdmin / PlatformAdmin
//   Archive / restore                                PlatformAdmin
//   Manage an app's admins / transfer owner          PlatformAdmin
//   Manage platform admins                           PlatformAdmin (never delete last row)
//   View an app's cost and usage                     AppAdmin(own) / PlatformAdmin
//   View portfolio cost and usage                    PlatformAdmin
//   View backups (dumps + instance protection)       owner / AppAdmin(own) / PlatformAdmin
//   Restore a backup                                  PlatformAdmin ONLY
//   Delete a backup                                   PlatformAdmin ONLY
//   Deploy a pinned (previously successful) sha       PlatformAdmin ONLY

import { pool } from "./db.js";

export async function isPlatformAdmin(email) {
  if (!email) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM platform_admins WHERE email = $1 LIMIT 1`,
    [email],
  );
  return rows.length > 0;
}

export async function isAppAdmin(email, appId) {
  if (!email) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM app_admins WHERE app_id = $1 AND email = $2 LIMIT 1`,
    [appId, email],
  );
  return rows.length > 0;
}

// The full permission context for one request against one app (or none). Computed once
// per request from the DB, so route handlers never re-derive entitlement inconsistently.
export async function permsFor(email, app) {
  const platformAdmin = await isPlatformAdmin(email);
  const appAdmin = app ? platformAdmin || (await isAppAdmin(email, app.id)) : false;
  const owner = app ? app.owner_email === email : false;
  return {
    email,
    platformAdmin,
    appAdmin, // true for platform admins on any app
    owner,
    canSeePending: () => platformAdmin || appAdmin || owner,
    canEditMetadata: () => appAdmin, // app admins + platform admins
    canFirstDeploy: () => platformAdmin, // vetting gate: platform admin ONLY
    canRedeploy: () => appAdmin,
    canArchiveRestore: () => platformAdmin,
    canManageAppAdmins: () => platformAdmin,
    canManagePlatformAdmins: () => platformAdmin,
    canSeeCostUsage: () => appAdmin, // own app for app admins; all for platform admins
    // Backups: the app's people get read-only reassurance (their dumps exist, the
    // instance is protected); every ACTION on a backup is platform-admin only.
    canViewBackups: () => appAdmin || owner, // appAdmin is true for platform admins
    canRestoreBackup: () => platformAdmin,
    canDeleteBackup: () => platformAdmin,
    canDeployPinned: () => platformAdmin,
  };
}

// Whether a given app card is visible to this identity in the main grid / listing.
export function cardVisible(app, perms) {
  if (app.status === "deployed") return true; // visible to all users
  // registered (pending) or archived: owner + its app admins + platform admins only.
  return perms.platformAdmin || perms.appAdmin || app.owner_email === perms.email;
}
