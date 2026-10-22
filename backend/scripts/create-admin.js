#!/usr/bin/env node
/**
 * Create the first admin account — the one manual step a fresh deployment needs.
 *
 *   npm run create-admin -- --username principal
 *   npm run create-admin -- --username principal --name "Mrs Rao" --force
 *
 * The password is read from a hidden prompt: it is never taken from an argument,
 * an environment variable, a file, a shell history entry or a log line. The
 * account itself is created by services/adminAccounts.js, the same way every
 * other user is written, and the password is validated with the app's own
 * complexity rule.
 *
 * Runs against whatever DATABASE_URL points at — including a production
 * database. It is deliberately NOT blocked by the test-database guard in
 * src/config/test-env.js: that guard exists to stop DESTRUCTIVE scripts (the
 * fixture seed, the test suite) wiping the wrong database, and this script only
 * ever INSERTs one admin row. Point it at production on purpose, from the
 * release machine.
 *
 * Exit codes: 0 created · 1 error (bad input, weak password, already exists) ·
 * 2 refused by the test-database guard (should not happen — see above).
 *
 * @module scripts/create-admin
 */
'use strict';

/* Load the same .env the app does, so DATABASE_URL resolves the way `npm start`
   sees it. Read before any service is required. */
require('dotenv').config();

/* ── Input plumbing ─────────────────────────────────────────────────────────
   Interactive (a real terminal): a hidden prompt for the password, so it never
   appears on screen or in scrollback. Non-interactive (stdin piped, e.g. an
   automated run): there is no echo to hide, and two readline interfaces over one
   piped stream would fight over the buffer — so when stdin is not a TTY the
   whole input is read ONCE and handed out line by line. */

let pipedLines = null;

/** Read all of stdin as an array of lines (piped/non-interactive mode). */
function readAllLines() {
  if (pipedLines) return Promise.resolve(pipedLines);
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => {
      pipedLines = buf.split(/\r?\n/);
      resolve(pipedLines);
    });
    process.stdin.resume();
  });
}

/** Non-interactive answers share one cursor over {@link readAllLines}. */
let pipedCursor = 0;
async function nextPipedLine() {
  const lines = await readAllLines();
  const line = lines[pipedCursor] ?? '';
  pipedCursor += 1;
  return line;
}

/** Read one line: echo suppressed on a real terminal, plain when piped. */
function promptLine(question) {
  if (!process.stdin.isTTY) {
    // Print the prompt for a readable transcript, then take the next piped line.
    process.stdout.write(question);
    return nextPipedLine().then((line) => { process.stdout.write('\n'); return line; });
  }
  return promptHidden(question);
}

/** Read one line from stdin with echo suppressed (interactive terminals only). */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    output.write(question);
    input.resume();
    input.setRawMode(true);
    input.setEncoding('utf8');

    let value = '';
    const onData = (char) => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          cleanup();
          output.write('\n');
          resolve(value);
          break;
        case '\u0003': // Ctrl-C
          cleanup();
          output.write('\n');
          reject(new Error('Cancelled.'));
          break;
        case '\u007f': // Backspace
        case '\b':
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          break;
        default:
          // Ignore other control characters; keep printable input only.
          if (char >= ' ') {
            value += char;
            output.write('*');
          }
      }
    };
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };
    input.on('data', onData);
  });
}

/** Read one plain (echoed) line, for the username prompt. */
function promptPlain(question) {
  return promptLine(question);
}

/** Parse `--flag value` / `--flag` pairs from argv. */
function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--force') { args.force = true; continue; }
    if (token === '--username' || token === '--name') {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Lazy: only touch Prisma (and the database) after the input is settled.
  const { createFirstAdmin, AdminAccountError } = require('../src/services/adminAccounts');
  const prisma = require('../src/services/prisma');

  try {
    const username = (args.username || (await promptPlain('Admin username: '))).trim();
    if (!username) {
      console.error('A username is required (--username <name>).');
      process.exitCode = 1;
      return;
    }

    const password = await promptLine('Admin password (hidden): ', { hidden: true });
    const confirm = await promptLine('Confirm password: ', { hidden: true });
    if (password !== confirm) {
      console.error('The passwords do not match. Nothing was created.');
      process.exitCode = 1;
      return;
    }

    const account = await createFirstAdmin({ username, password, name: args.name, force: args.force });
    console.log(`\nAdmin account created: ${account.username} (${account.name}).`);
    console.log('The password is not stored anywhere in plain text — keep it safe.');
  } catch (err) {
    if (err instanceof AdminAccountError) {
      console.error(`\n${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err && err.code === 'UNSAFE_DATABASE') {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main();
