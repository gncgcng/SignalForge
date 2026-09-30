import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import {
  hashPassword,
  isPasswordHasherReady,
  isValidPassword,
  verifyAndClassifyPassword
} from "../src/modules/auth/authService.js";

// Built with the old formula inline, so this test keeps working if the legacy code is refactored.
function legacyRecord(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: createHash("sha256").update(`${salt}:${password}`).digest("hex") };
}

const scrypt = hashPassword("correct horse battery");
const scryptParts = scrypt.hash.split("$");
const legacy = legacyRecord("correct horse battery");

const result = {
  newHashIsTaggedScrypt:
    /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(scrypt.hash) &&
    scrypt.salt === "" &&
    scryptParts.length === 6,
  newHashesAreSalted: hashPassword("same").hash !== hashPassword("same").hash,
  scryptVerifies:
    isValidPassword("correct horse battery", scrypt) &&
    JSON.stringify(verifyAndClassifyPassword("correct horse battery", scrypt)) === JSON.stringify({ valid: true, legacy: false }),
  legacyVerifies:
    /^[0-9a-f]{64}$/.test(legacy.hash) &&
    isValidPassword("correct horse battery", legacy) &&
    JSON.stringify(verifyAndClassifyPassword("correct horse battery", legacy)) === JSON.stringify({ valid: true, legacy: true }),
  wrongPasswordFailsBothWithoutThrowing:
    verifyAndClassifyPassword("wrong", scrypt).valid === false &&
    verifyAndClassifyPassword("wrong", legacy).valid === false,
  // Cost parameters come from the stored string, so older/newer parameter choices keep verifying.
  storedParametersAreHonoured: (() => {
    const salt = randomBytes(16);
    const hash = scryptSync("pw-123456", salt, 64, { N: 1024, r: 8, p: 1 }).toString("hex");
    return verifyAndClassifyPassword("pw-123456", { salt: "", hash: `scrypt$1024$8$1$${salt.toString("hex")}$${hash}` }).valid;
  })(),
  malformedOrEmptyRecordsFailClosed: [
    { salt: "", hash: "" }, // anonymized (deleted) account
    null,
    { salt: "", hash: "scrypt$" },
    { salt: "", hash: "scrypt$abc$8$1$00$00" },
    { salt: "", hash: `${scrypt.hash}$extra` },
    { salt: "", hash: "scrypt$16384$8$1$zz$" }
  ].every((record) => {
    const outcome = verifyAndClassifyPassword("correct horse battery", record);
    return outcome.valid === false;
  }),
  healthCheckStillReady: isPasswordHasherReady() === true
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Password hashing check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
