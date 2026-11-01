# Test fixtures

`localhost-cert.pem` / `localhost-key.pem` are a **self-signed certificate pair for `localhost`**,
generated only so `scripts/smoke.mjs` can start a throwaway HTTPS server on a random loopback port
and exercise the proxy / TLS paths of `lib/proxy-agent.js`.

They are not credentials for anything: no service, account or host trusts this certificate, and it
never leaves the loopback interface. Regenerate with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout localhost-key.pem -out localhost-cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"
```
