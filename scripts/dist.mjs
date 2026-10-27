#!/usr/bin/env node
// Package the macOS app (run after `electron-vite build`; see `pnpm dist`).
//
// Signs with a real certificate from the login keychain when there is one
// (ARC_SIGN_IDENTITY, else the first "Developer ID Application" or "Apple
// Development" identity), otherwise ad hoc. The difference matters: Chromium
// keeps its cookie key in the keychain, and the keychain remembers "Always
// Allow" against the app's signing identity. An ad-hoc signature changes with
// every build, so every new build asks for the login password again; a
// certificate-signed build keeps its identity and is asked only once.
import { execFileSync, spawnSync } from 'node:child_process'

function signingIdentity() {
  if (process.env.ARC_SIGN_IDENTITY) return process.env.ARC_SIGN_IDENTITY
  let out = ''
  try {
    out = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  } catch {
    return null
  }
  const names = [...out.matchAll(/^\s*\d+\) [0-9A-F]+ "(.+)"$/gm)].map((m) => m[1])
  return names.find((n) => n.startsWith('Developer ID Application:')) ?? names.find((n) => n.startsWith('Apple Development:')) ?? null
}

const identity = signingIdentity()
console.log(
  identity
    ? `[dist] Signing with "${identity}"`
    : '[dist] No signing certificate found: ad-hoc signature (the keychain will ask again after each new build)'
)
const result = spawnSync('electron-builder', ['--mac', '--arm64', `-c.mac.identity=${identity ?? '-'}`], { stdio: 'inherit' })
process.exit(result.status ?? 1)
