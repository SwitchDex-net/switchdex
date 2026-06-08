---
name: Bug report
about: Report something that broke or behaved unexpectedly
title: "[bug] "
labels: bug
---

**Version:**
<!-- Settings page, or: pct exec <CTID> -- grep version /opt/switchdex/frontend/package.json -->

**What I did:**
<!-- the steps that led to the problem -->

**What I expected:**

**What happened:**
<!-- paste the EXACT error text, verbatim — not a paraphrase -->

---

**Device involved (if any):**
- Vendor / OS / model:
- How managed: SSH / SNMP / eAPI / controller (UniFi/Omada)

**Backend logs around the time it happened:**
<!-- pct exec <CTID> -- docker compose -f /opt/switchdex/docker-compose.yml logs --tail 100 backend -->
```
(paste here)
```

**Browser console (for UI bugs):**
<!-- F12 → Console → copy any red errors -->
```
(paste here)
```

**Anything else** (screenshots, what you'd already tried, whether it's reproducible):
