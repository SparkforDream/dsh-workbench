/**
 * Mint the browser-session cookie this GUI expects, for local verification only.
 *
 * The desktop app opens the Web GUI with a `?token=` query on the launch URL;
 * that token lives in process memory and is not readable from disk. The cookie
 * it would mint, however, is deterministic given the persisted signing secret,
 * so this script reproduces exactly what `BrowserAuth.authorizeIndex` writes:
 *
 *   name  = "dsh-auth-" + base64url(sha256(authority without :port))
 *   value = "v1." + base64url(JSON payload) + "." + base64url(hmac-sha256(secret, body))
 *
 * Usage: node test/mint-cookie.mjs <authority> [expiresInDays]
 *   e.g. node test/mint-cookie.mjs 127.0.0.1:14121
 *
 * Prints `NAME=<cookie name>` and `VALUE=<cookie value>` on one line each so a
 * shell can consume it without a JSON parser.
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const authority = process.argv[2]
if (authority === undefined) {
  console.error('usage: node test/mint-cookie.mjs <host:port> [days]')
  process.exit(2)
}
const days = Number(process.argv[3] ?? 1)

const credentialsPath = join(homedir(), '.dsh', '.credentials.yaml')
const yaml = readFileSync(credentialsPath, 'utf8')

// Minimal extraction: the record is a fixed-shape YAML block, and pulling in
// a YAML parser just to read one scalar would add a dependency to a diagnostic
// tool. Anchor on the browser-session entry, then take the `secret:` line that
// follows it.
const anchor = yaml.indexOf('client-connection/browser-session')
if (anchor < 0) {
  console.error('browser-session record not found in .credentials.yaml')
  process.exit(3)
}
const tail = yaml.slice(anchor)
const secretMatch = /\bsecret:\s*["']?([A-Za-z0-9+/=_.-]{16,})["']?/.exec(tail)
if (secretMatch === null) {
  console.error('secret not found inside the browser-session record')
  process.exit(4)
}
const secret = secretMatch[1]

const base64url = buffer => buffer.toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')

// The stored secret is base64url-encoded 32 raw bytes; the server decodes it
// before using it as the HMAC key (`canonicalSecret` rejects anything whose
// decoded length is not exactly 32 bytes). Using the encoded string directly
// signs a different message than the server verifies.
const key = Buffer.from(secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
if (key.byteLength !== 32) {
  console.error(`decoded secret is ${key.byteLength} bytes, expected 32`)
  process.exit(5)
}

// `cookieName(authority)` hashes the authority AS SENT in the Host header,
// port included — not the bare host.
const authorityAsSeen = authority
const name = `dsh-auth-${base64url(createHash('sha256').update(authorityAsSeen).digest())}`

const issuedAt = Date.now()
const payload = {
  version: 1,
  authority,
  issuedAt,
  expiresAt: issuedAt + days * 24 * 60 * 60 * 1000,
}
const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
const signatureBytes = createHmac('sha256', key).update(body).digest()
const value = `v1.${body}.${base64url(signatureBytes)}`

console.log(`NAME=${name}`)
console.log(`VALUE=${value}`)
