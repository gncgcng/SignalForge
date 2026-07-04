import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateUsername } from "../src/modules/profiles/profileService.js";

const migration = readFileSync("migrations/024_user_profiles.sql", "utf8");
const repositories = readFileSync("src/db/repositories.js", "utf8");
const authService = readFileSync("src/modules/auth/authService.js", "utf8");
const profileService = readFileSync("src/modules/profiles/profileService.js", "utf8");
const profileController = readFileSync("src/modules/profiles/profileController.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");

for (const username of ["abc", "Trader_20", "x_y_z", "A1234567890123456789"]) {
  assert.equal(validateUsername(username), username);
}

for (const username of ["ab", "has space", "dash-name", "too_long_username_value", "bad.name", ""]) {
  assert.throws(() => validateUsername(username), /Username must be 3-20 characters/);
}

assert.match(migration, /username_normalized text/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_normalized/);
assert.match(migration, /WHERE username_normalized IS NOT NULL/);
assert.match(repositories, /normalizeUsernameForLookup\(username\)/);
assert.match(repositories, /WHERE username_normalized = \$1 AND id <> \$2/);
assert.match(repositories, /You can change your username once every 30 days/);

assert.match(authService, /usernameRequired: !user\.username/);
assert.match(authService, /findUserByUsername\(normalizedUsername\)/);
assert.match(authService, /USERNAME_TAKEN/);

assert.match(profileController, /pathname === "\/api\/profile\/me"/);
assert.match(profileController, /pathname\.startsWith\("\/api\/profiles\/"\)/);
assert.match(profileService, /publicProfileEnabled/);
assert.match(profileService, /Public profile not found/);
assert.doesNotMatch(profileService, /email:/);
assert.doesNotMatch(profileService, /telegram/i);
assert.doesNotMatch(profileService, /affiliate/i);

assert.match(html, /name="username"/);
assert.match(html, /id="profile-view"/);
assert.match(html, /id="username-required-panel"/);
assert.match(html, /id="public-profile-page"/);
assert.match(app, /isPublicProfileRoute/);
assert.match(app, /loadProfile\(\)/);
assert.match(app, /usernameRequired/);
assert.match(app, /settings-public-profile/);

console.log("User profile and username tests passed.");
