/// <reference path="../pb_data/types.d.ts" />
/**
 * Accounts for a multi-user app (SYSTEM-OWNED — hash-locked in the ownership
 * canon; applied once, before the starter's own migrations).
 *
 * spec/v0_2/auth.md §4: a multi-user app's accounts are the adapter's to keep.
 * On this stack they are records of PocketBase's own `users` auth collection,
 * so the app's collection rules can name the signed-in person
 * (`@request.auth.id`, `@request.auth.role`). This prepares that collection
 * for the adapter, which is the only thing that creates, changes or signs in
 * an account:
 *
 *   login   what a person signs in with; unique, stored trimmed and lower-cased
 *   role    owner (sees and changes every record) or member (only its own)
 *   active  a deactivated account cannot sign in, and its sessions and agents stop
 *
 * PocketBase's own sign-in (password, OTP, OAuth2) is turned off and every rule
 * is locked to superusers, so nobody signs up around the invites and no
 * account is served by the records API. People join by accepting an invite
 * (POST /api/_a2app/invites/{code}) and sign in with POST /api/_a2app/session.
 *
 * Applied on every app: on a single-user one the collection is unused, and
 * locked all the same.
 */
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new TextField({ name: "login", required: true, max: 254 }));
    users.fields.add(new SelectField({ name: "role", required: true, maxSelect: 1, values: ["owner", "member"] }));
    users.fields.add(new BoolField({ name: "active" }));
    users.addIndex("idx_users_a2app_login", true, "`login`", "");
    // A person signs in with a login, which need not be an email address.
    users.fields.getByName("email").required = false;

    users.passwordAuth.enabled = false;
    users.otp.enabled = false;
    users.oauth2.enabled = false;
    users.mfa.enabled = false;
    users.authRule = null;
    users.manageRule = null;

    users.listRule = "id = @request.auth.id";
    users.viewRule = "id = @request.auth.id";
    users.createRule = null;
    users.updateRule = null;
    users.deleteRule = null;
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.removeIndex("idx_users_a2app_login");
    users.fields.removeByName("login");
    users.fields.removeByName("role");
    users.fields.removeByName("active");
    users.fields.getByName("email").required = true;

    users.passwordAuth.enabled = true;
    users.authRule = "";

    users.createRule = "";
    users.updateRule = "id = @request.auth.id";
    users.deleteRule = "id = @request.auth.id";
    app.save(users);
  },
);
