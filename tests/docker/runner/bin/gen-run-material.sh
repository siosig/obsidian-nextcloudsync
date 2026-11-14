#!/usr/bin/env bash
# Generate the per-run secret material for the docker test suite.
#
# Produces a throwaway root CA, a server certificate for nc.test signed by it,
# and three random passwords. It also produces two probe certificates: one for
# untrusted.test signed by a second throwaway CA that no trust store receives,
# and one for expired.test signed by the root CA with a validity period in the
# past. Everything is written to stdout as exactly eleven lines of the form
# NAME=<base64 -w0 value>; nothing is persisted.
# The CA private keys are used only inside the temporary work directory and are
# never printed, and neither is the certificate of the untrusted-probe CA.
# Do not enable xtrace here: it would leak secrets to stderr.
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

# Untrusted-probe CA: same construction as the root CA with a distinct subject.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/uca.key"
openssl req -x509 -new -sha256 -days 2 \
  -config "$work/ca.cnf" -extensions v3_ca \
  -subj "/CN=ncs-suite untrusted probe root" \
  -key "$work/uca.key" -out "$work/uca.crt"

cat >"$work/untrusted.ext" <<'EOF'
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:untrusted.test
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF

# untrusted.test: ECDSA P-256, SAN untrusted.test, issued by the untrusted-probe CA.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/untrusted.key"
openssl req -new -sha256 -subj "/CN=untrusted.test" \
  -key "$work/untrusted.key" -out "$work/untrusted.csr"
openssl x509 -req -sha256 -days 1 \
  -in "$work/untrusted.csr" -CA "$work/uca.crt" -CAkey "$work/uca.key" \
  -set_serial "0x$(openssl rand -hex 16)" \
  -extfile "$work/untrusted.ext" -out "$work/untrusted.crt"

# expired.test: `openssl x509 -req` cannot set a start date in the past, so
# `openssl ca` signs it with the root CA over a validity period that has ended.
cat >"$work/sign.cnf" <<EOF
[ca]
default_ca = d
[d]
database = $work/db/index.txt
new_certs_dir = $work/db
default_md = sha256
policy = p
unique_subject = no
rand_serial = yes
[p]
commonName = supplied
[ext]
basicConstraints = critical,CA:FALSE
extendedKeyUsage = serverAuth
subjectAltName = DNS:expired.test
EOF
mkdir -p "$work/db"
: >"$work/db/index.txt"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/expired.key"
openssl req -new -sha256 -subj "/CN=expired.test" \
  -key "$work/expired.key" -out "$work/expired.csr"
openssl ca -batch -notext -config "$work/sign.cnf" \
  -cert "$work/ca.crt" -keyfile "$work/ca.key" \
  -in "$work/expired.csr" -out "$work/expired.crt" \
  -startdate 20200101000000Z -enddate 20200102000000Z -extensions ext

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
emit_file SUITE_PROBE_UNTRUSTED_CERT_PEM "$work/untrusted.crt"
emit_file SUITE_PROBE_UNTRUSTED_KEY_PEM "$work/untrusted.key"
emit_file SUITE_PROBE_EXPIRED_CERT_PEM "$work/expired.crt"
emit_file SUITE_PROBE_EXPIRED_KEY_PEM "$work/expired.key"
