#!/usr/bin/env node
/**
 * QA ENV LOADER — loads `.env.test` and then runs the script named on the
 * command line, in the SAME process, so the target sees TEST_DATABASE_URL.
 *
 *   node scripts/qa-run.js scripts/qa-seed.js
 *
 * This exists because the destructive-entry guards read TEST_DATABASE_URL from
 * the environment, and `.env.test` is the only file that sets it. Loading it
 * first (dotenv's default would otherwise read `.env`, which points at the live
 * Supabase database) is what keeps every QA script on the test database.
 */
const path = require('node:path');
const dotenv = require('dotenv');

const envTestPath = path.join(__dirname, '..', '.env.test');
const res = dotenv.config({ path: envTestPath, override: true });
if (res.error) {
  console.error('[qa-run] could not load .env.test:', res.error.message);
  process.exit(1);
}

const target = process.argv[2];
if (!target) {
  console.error('[qa-run] usage: node scripts/qa-run.js <script.js> [args...]');
  process.exit(1);
}
process.argv = [process.argv[0], target, ...process.argv.slice(3)];
require(path.resolve(__dirname, '..', target));
