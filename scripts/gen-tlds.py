#!/usr/bin/env python3
"""Regenerate src/shared/tlds.ts from the IANA root zone list.

Usage: curl -s https://data.iana.org/TLD/tlds-alpha-by-domain.txt -o /tmp/tlds.txt
       python3 scripts/gen-tlds.py /tmp/tlds.txt
"""
import sys

src = sys.argv[1]
with open(src) as f:
    header = f.readline().strip().lstrip('# ')
    labels = [l.strip().lower() for l in f if l.strip() and not l.startswith('#') and '--' not in l]

out = f"""// Generated from https://data.iana.org/TLD/tlds-alpha-by-domain.txt
// {header}. Punycode (xn--) entries are omitted; regenerate with scripts/gen-tlds.py.
// Stored as one space-separated string: cheaper to parse than an array literal.
const RAW =
  '{' '.join(labels)}'

let cache: Set<string> | null = null

export function isKnownTld(label: string): boolean {{
  cache ??= new Set(RAW.split(' '))
  return cache.has(label.toLowerCase())
}}
"""
with open('src/shared/tlds.ts', 'w') as f:
    f.write(out)
