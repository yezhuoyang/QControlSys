# Deploying QuantumOS at quantumos.it.com

QuantumOS runs on the qccd.academy droplet (165.232.55.161, 2 vCPUs, about 4 GB, Ubuntu with
nginx 1.18), beside QCCD Studio, in the same way as QCCD Studio's official service: the image is
built on a development machine and loaded with `docker load`, a container listens on
`127.0.0.1` only, and the host's nginx terminates HTTPS and proxies to it.

| File | What it is |
| --- | --- |
| `../Dockerfile` | The image: the Lean model, the Node server, the course, QCCD Studio and its pinned compiler |
| `docker-compose.prod.yml` | The container on the droplet: `127.0.0.1:8400`, 1 GB and one CPU, two simulations at once |
| `nginx-quantumos.conf` | The nginx site for `quantumos.it.com` and `www.quantumos.it.com` |

## 1. DNS (Namecheap → Domain List → quantumos.it.com → Advanced DNS)

Use Namecheap's own name servers (*Nameservers: Namecheap BasicDNS*). Under **Host records**:

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| A Record | `@` | `165.232.55.161` | Automatic |
| CNAME Record | `www` | `quantumos.it.com.` | Automatic |

- Delete Namecheap's parking records if they are still there: the `CNAME www → parkingpage.namecheap.com` and the `URL Redirect @` record. A URL Redirect on `@` overrides the A record.
- No AAAA record: the droplet has no public IPv6 address (qccd.academy publishes none). Add one only if you enable IPv6 on the droplet.
- Optional, under **Host records**: a `CAA` record, host `@`, value `0 issue "letsencrypt.org"`, so that only Let's Encrypt may issue certificates for the domain.
- Leave the mail settings alone; the site sends no mail.

Check from any computer. Both names should give the droplet's address:

```sh
nslookup quantumos.it.com        # Address: 165.232.55.161
nslookup www.quantumos.it.com    # Address: 165.232.55.161
```

**State on 2026-11-24:** both names already resolve to 165.232.55.161 through
`dns1/dns2.registrar-servers.com`, and the site answers over HTTPS with a valid certificate.
Nothing in this section needs to change.

## 2. Build the image and copy it to the droplet

On the development machine, from the repository root, with Docker running:

```sh
TAG=$(git rev-parse --short HEAD)
docker build -t quantumos:$TAG .
docker save quantumos:$TAG | gzip -1 | ssh root@qccd.academy 'gunzip | docker load'
```

A first build takes a few minutes (Lean toolchain and model); later builds reuse those layers.
Rehearse locally before shipping:

```sh
QUANTUMOS_TAG=$TAG docker compose -p rehearsal -f deploy/docker-compose.prod.yml up -d
curl -s http://127.0.0.1:8400/api/riscq/run?example=qccd-ghz3 | head -c 200
QUANTUMOS_TAG=$TAG docker compose -p rehearsal -f deploy/docker-compose.prod.yml down
```

## 3. First installation on the droplet (as root)

```sh
mkdir -p /opt/quantumos && cd /opt/quantumos
# copy deploy/docker-compose.prod.yml here (scp), then:
printf 'QUANTUMOS_TAG=%s\n' <TAG> > .env
ss -ltnp | grep -q ':8400 ' && echo "port 8400 is taken: change it here and in nginx"
docker compose -f docker-compose.prod.yml up -d
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8400/      # 200

cp nginx-quantumos.conf /etc/nginx/sites-available/quantumos.it.com    # from deploy/
ln -s /etc/nginx/sites-available/quantumos.it.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

certbot --nginx -d quantumos.it.com -d www.quantumos.it.com --redirect
```

certbot adds the HTTPS server block and the HTTP-to-HTTPS redirect and renews the certificate on
its own timer (`systemctl list-timers | grep certbot`).

## 4. Updating

```sh
# on the development machine: steps of section 2 with the new commit's TAG
ssh root@qccd.academy 'cd /opt/quantumos && sed -i "s/^QUANTUMOS_TAG=.*/QUANTUMOS_TAG=<TAG>/" .env \
  && docker compose -f docker-compose.prod.yml up -d'
```

Then check the site (QCONTROL_URL can be any deployment):

```sh
curl -s https://quantumos.it.com/api/riscq/examples | head -c 200
PLAYWRIGHT_CORE=<playwright-core installation> QCONTROL_URL=https://quantumos.it.com \
  node studio/course/check-course.mjs A1 C2 E3       # answers every exercise of three lessons
```

**Rolling back:** set `.env` to the previous tag and `docker compose -f docker-compose.prod.yml up -d`.
`docker images quantumos` lists the tags still on the droplet; `docker image prune` removes unused ones.

## Operating it

```sh
cd /opt/quantumos
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail 50 web
docker stats --no-stream quantumos-web-1        # a heavy run peaks near 190 MiB
```

The server stores nothing and has no accounts: course progress stays in each visitor's browser.
Load is bounded by `QUANTUMOS_MAX_RUNS` (2) and `QUANTUMOS_MAX_QUEUE` (8) in the compose file;
beyond them a request gets HTTP 503 "The simulator is busy" until a run finishes.
