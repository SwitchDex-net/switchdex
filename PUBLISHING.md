# Publishing SwitchDex to GitHub

Step-by-step to get this repo live at `github.com/switchdex-net/switchdex`.

## 0. Pre-flight (do this once, before the first push)

- **Confirm no secrets are in the tree.** This repo ships only `.env.example`
  (placeholders) — never a real `.env`. The included `.gitignore` blocks `.env`,
  keys, and build artifacts from ever being committed. Double-check:
  ```bash
  find . -name ".env" -not -name ".env.example"   # should print nothing
  ```
  If a real secret ever does get pushed to a public repo, rotate it — assume it
  was scraped within minutes, even if you delete the commit.

## 1. Create the GitHub organization

You've created the org **`switchdex-net`** (the bare `switchdex` name was
unavailable). All URLs in this repo already point to `github.com/switchdex-net/...`
to match. If you ever rename the org, update the `git clone` URL in
`proxmox/switchdex.sh` and the links in `README.md` / `docs/BACKEND.md` accordingly.

## 2. Install tooling (if needed)

```bash
git --version            # already present on most systems
# GitHub CLI makes auth painless:
#   macOS:  brew install gh
#   see:    https://cli.github.com
gh auth login            # follow the browser prompts
```

## 3. Create the repository

With the GitHub CLI, from inside this folder:

```bash
gh repo create switchdex-net/switchdex --public --source=. --remote=origin \
  --description "Open-source network infrastructure monitoring for small business"
```

Or via the website: **New repository** → owner `switchdex-net`, name `switchdex`,
**Public**, and do **not** initialize with a README/license/gitignore (this repo
already has them).

## 4. Initialize and push

```bash
cd switchdex
git init
git add .
git commit -m "Initial public release of SwitchDex"
git branch -M main
git remote add origin https://github.com/switchdex-net/switchdex.git
git push -u origin main
```

(If you used `gh repo create ... --source=.` the remote is already set — skip
`git remote add`.)

Your code is now live at `https://github.com/switchdex-net/switchdex`.

## 5. Tag a release

Pin installs to a version rather than a moving `main`:

```bash
git tag -a v1.0.0 -m "SwitchDex 1.0.0"
git push origin v1.0.0
```

Then on GitHub → **Releases** → **Draft a new release** → choose `v1.0.0`.

## 6. The install command (served from GitHub)

The install scripts and docs already point at **GitHub raw**, so the Proxmox
installer works the moment the repo is public — no website required:

```
bash -c "$(curl -fsSL https://raw.githubusercontent.com/switchdex-net/switchdex/v1.0.0/proxmox/switchdex.sh)"
```

Note this URL is pinned to the **`v1.0.0` tag**, so you must create that tag
(step 5) before the command resolves. Using a tag rather than `main` means the
command is reproducible and won't change as you push new commits. When you cut a
new release, bump the tag in the command (e.g. `v1.1.0`).

The `git clone` inside `proxmox/switchdex.sh` targets
`github.com/switchdex-net/switchdex`. For production, pin it to the same tag:
```bash
git clone --depth 1 --branch v1.0.0 https://github.com/switchdex-net/switchdex.git .
```

### Later: a friendlier URL via switchdex.net (optional)

Once your site is live, you can serve the scripts from a short vanity URL
(`https://switchdex.net/proxmox/switchdex.sh`) — either by hosting the files
there or redirecting to the GitHub raw URL. Until then, the raw URLs above are
all you need. If you switch to switchdex.net URLs later, update the command in
`proxmox/README.md`, `docs/BACKEND.md`, and the header comments in
`proxmox/switchdex.sh` / `proxmox/update.sh`.

## 7. Nice-to-haves (later)

- A `CONTRIBUTING.md` and issue templates once people start filing issues.
- GitHub Actions CI to run `py_compile` / a lint on push (you've been validating
  by hand — automating it keeps PRs honest).
- Submit the Proxmox script to https://community-scripts.org as a `ct/` +
  `install/` pair once the repo is public and stable.

## Updating later

```bash
git add -A
git commit -m "Describe what changed"
git push
# for a new release:
git tag -a v1.1.0 -m "SwitchDex 1.1.0" && git push origin v1.1.0
```
