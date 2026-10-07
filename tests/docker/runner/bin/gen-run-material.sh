#!/usr/bin/env bash
# Generate the per-run secret material for the docker test suite.
#
# Produces a throwaway root CA, a server certificate for nc.test signed by it,
# and three random passwords. Everything is written to stdout as exactly
# seven lines of the form NAME=<base64 -w0 value>; nothing is persisted.
# The CA private key is used only inside the temporary work directory and is
# never printed. Do not enable xtrace here: it would leak secrets to stderr.
set -euo pipefail
umask 077

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Minimal OpenSSL config so the result does not depend on the system openssl.cnf.
cat >"$work/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = ncs-suite test root
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF

cat >"$work/server.ext" <<'EOF'
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:nc.test
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF

# Root CA: ECDSA P-256, valid for 2 days.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/ca.key"
openssl req -x509 -new -sha256 -days 2 \
  -config "$work/ca.cnf" -extensions v3_ca \
  -key "$work/ca.key" -out "$work/ca.crt"

# Server certificate: ECDSA P-256, SAN nc.test, serverAuth, valid for 1 day.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/tls.key"
openssl req -new -sha256 -subj "/CN=nc.test" -key "$work/tls.key" -out "$work/tls.csr"
openssl x509 -req -sha256 -days 1 \
  -in "$work/tls.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" \
  -set_serial "0x$(openssl rand -hex 16)" \
  -extfile "$work/server.ext" -out "$work/tls.crt"

ca_hash="$(openssl x509 -subject_hash_old -noout -in "$work/ca.crt")"

# 32 alphanumeric characters from 48 random bytes.
gen_password() {
  local pw
  pw="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"
  if [[ ${#pw} -ne 32 ]]; then
    echo "gen-run-material: password generation produced ${#pw} characters" >&2
    return 1
  fi
  printf '%s' "$pw"
}

admin_pw="$(gen_password)"
user2_pw="$(gen_password)"
db_pw="$(gen_password)"

emit_file() { printf '%s=%s\n' "$1" "$(base64 -w0 <"$2")"; }
emit_value() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | base64 -w0)"; }

emit_file SUITE_CA_CERT_PEM "$work/ca.crt"
emit_file SUITE_TLS_CERT_PEM "$work/tls.crt"
emit_file SUITE_TLS_KEY_PEM "$work/tls.key"
emit_value SUITE_CA_HASH "$ca_hash"
emit_value SUITE_NC_ADMIN_PASSWORD "$admin_pw"
emit_value SUITE_NC_USER2_PASSWORD "$user2_pw"
emit_value SUITE_NC_DB_PASSWORD "$db_pw"
