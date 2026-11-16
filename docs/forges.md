# agent-lens pr: images into a pull request

`agent-lens pr` makes images linkable in a pull request and writes the comment or description that shows them.
Forges have no API in common, so each one is a small provider behind the same commands.

```sh
agent-lens pr resolve --repo owner/name --pr 42                 # read only: does the tool find the pull request?
agent-lens pr upload  --repo owner/name --pr 42 shot.png other.png
#   ![shot](<url>)
agent-lens pr upload  --repo owner/name --pr 42 --compare evidence/compare [--only-changed] [--composite] > table.md
#   | | Vorher | Nachher |
#   |---|---|---|
#   | `history` | ![Vorher](<url>) | ![Nachher](<url>) |
agent-lens pr comment --repo owner/name --pr 42 --body-file table.md
agent-lens pr description --repo owner/name --pr 42 --body-file table.md --append
agent-lens pr table --compare evidence/compare                  # the table with local paths, no forge involved
agent-lens pr evidence --repo owner/name --pr 42 --before evidence/before --after evidence/after   # first time
agent-lens pr evidence --repo owner/name --pr 42 --after evidence/after                            # every rerun
```

- **`evidence` keeps one before/after table in the description up to date** and is the short way for a pull
  request whose "after" changes again: it takes the capture directories of `mc scene run` (or single files)
  directly, with no compare step and no stitched image. Without a `| Vorher | Nachher |` table in the description
  it uploads both sides and appends the table (one pair: two columns; several: a name column first). With a table
  it uploads only the "after" images and replaces only their cells; "before" and every other line stay as they
  are, so "before" is recorded once. Rows are matched by capture name (the only row takes the only capture);
  a capture without a row fails before anything is written. `--labels Before,After` for other headings.
  **It refuses a pair whose sides look the same**: identical image bytes, or the same hovered tooltip text (read
  from the `manifest.json` of `mc scene run`). That is almost always both sides running one build (a stale jar, a
  checkout on the wrong branch), so nothing is written. `--allow-unchanged` for a change that is not in the text
  (an icon, a colour). On a rerun `--before` is optional and only feeds this check.
- `--forge <name>` selects an entry of `forges` in the config; with exactly one entry it can be left out.
- `--dry-run` prints every write (method, URL, headers with the credentials replaced by `<redacted>`, body or
  body size) instead of sending it. Lookups (GET) still run. Run it first.
- `--compare <dir>` takes a directory written by `mc scene compare` or `web compare`: it uploads
  `<name>.before.png` and `<name>.after.png` per pair and prints the finished table; `--composite` uploads the
  `<name>.compare.png` files instead (one image per row, better for wide shots). The column labels are the ones
  given to `compare --labels`.
- **Evidence in one step:** `comment` and `description` take `--compare <dir>` too: the images are uploaded and
  the table is put after the text of `--body-file` (which is then optional). Run
  `pr description --append --compare <dir>` directly after creating the pull request. The images cannot be part of
  the request that creates it: OneDev and Forgejo attach a file to an existing pull request, so the link only
  exists afterwards.
- A recording of `mc record` next to a waveform (`<name>.mp4`, else `<name>.wav`) is uploaded as
  `<name>.before.wav` / `<name>.after.wav` and linked under its waveform (`[Audio](...)`, `[Video](...)`).
  `upload <files...>` prints a plain link for anything that is not an image.
- `description` without `--append` replaces the description.
- Uploading again adds files; nothing is deleted.
- `--json` prints the result as JSON.

## Config

```json
"forges": {
  "gh":   { "type": "github", "auth": { "type": "gh" } },
  "git":  { "type": "forgejo", "api": "https://git.example.net/api/v1",
            "auth": { "type": "token-env", "env": "FORGEJO_TOKEN" } },
  "code": { "type": "onedev", "api": "https://code.example.net/~api", "url": "https://code.example.net",
            "auth": { "type": "token-env", "env": "ONEDEV_TOKEN" } }
}
```

`auth`:

| `type` | Meaning |
|---|---|
| `none` (default) | no credentials are added. For a proxy that injects them, or for read-only use on a public repository. |
| `token-env` | the token is read from the environment variable `env` at call time and sent as `Authorization: <scheme> <token>`; `scheme` defaults to `Bearer` (`token` for Forgejo/Gitea). |
| `gh` | asks the GitHub CLI (`gh auth token`, optional `hostname`) at call time. |

A token is never written to the config, never printed and never stored by the tool.

## Providers

### github

- `api` default `https://api.github.com`, `url` default `https://github.com` (GitHub Enterprise: `https://host/api/v3`
  and `https://host`). `--repo owner/name`.
- Comment: `POST /repos/{repo}/issues/{n}/comments`. Description: `PATCH /repos/{repo}/pulls/{n}`.
- **Images.** GitHub has no API for comment attachments. The files are committed to a dedicated branch of the
  repository (`assetsBranch`, default `agent-lens-assets`) under `pr-<n>/<name>` through the Git Data API (blobs,
  tree, commit, ref) and linked as `https://github.com/<repo>/blob/<branch>/pr-<n>/<name>?raw=true`. The branch is
  an orphan, created on first use, and every upload is one commit. It adds binary history to the repository: delete
  the branch when the pull requests are merged if that matters. The token needs write access to contents. Uploading
  a file name again for the same pull request replaces the image that older comments show.

### forgejo (also `gitea`)

- `api` is `https://host/api/v1`. `--repo owner/name`.
- Images: `POST /repos/{owner}/{repo}/issues/{index}/assets` (multipart field `attachment`), the answer's
  `browser_download_url` is the link. Comment: `POST /repos/{owner}/{repo}/issues/{index}/comments`. Description:
  `PATCH /repos/{owner}/{repo}/pulls/{index}`. Endpoint names checked against the Forgejo swagger
  (`/swagger.v1.json`).

### onedev

- `api` is `https://host/~api`; `url` (optional) is the web address, used for links in the output.
  `--repo` is the project path or id, `--pr` the number shown in the UI; `--pr-id` takes the global id instead.
- Images: `POST /pulls/{id}/attachments/{name}` with the raw bytes; the answer is a server-relative
  `/~downloads/...` URL that works in the description and comments of that pull request.
  Comment: `POST /pull-request-comments`. Description: `POST /pulls/{id}/description`.

### GitLab

Not implemented. A provider needs: `GET /projects/:id/merge_requests/:iid` for `resolve` (the project id is the
URL-encoded path), `POST /projects/:id/uploads` (multipart field `file`) for images, whose answer carries a
`markdown` snippet and a project-relative `url`, `POST /projects/:id/merge_requests/:iid/notes` for a comment and
`PUT /projects/:id/merge_requests/:iid` with `description`. Tokens are sent as `PRIVATE-TOKEN` or as a Bearer
token.

## Adding a provider

A provider is one file in `cli/forge/` that exports `create(forge, {dryRun})` and returns:

```
resolve({repo, number, id?})     -> {id, repo, number, url, title, description, ...}   GET only
uploadImage(pr, file, name)      -> {markdownUrl}
uploadImages(pr, [{file, name}]) -> [{markdownUrl}]      optional, when all files should go in one request
comment(pr, markdown)            -> {url}
getDescription(pr)               -> markdown
setDescription(pr, markdown)     -> {url}
```

1. Build the HTTP client with `createClient({base, headers, auth: () => authHeaders(forge), dryRun})` from
   `cli/forge/http.mjs`. Use `get` / `find` for lookups and `write` for everything that changes something: `write`
   returns `null` in a dry run after printing the request, so return a placeholder URL in that case.
2. Register the type in `PROVIDERS` in `cli/forge/index.mjs`.
3. A forge without an upload API can reuse the branch strategy of `cli/forge/git-ref.mjs`: give `commitFiles` the
   seven git data calls (`getRef`, `getCommit`, `createBlob`, `createTree`, `createCommit`, `createRef`,
   `updateRef`) as `cli/forge/github.mjs` does.

Nothing else knows the provider: the commands, the table and `doctor` work from the config entry.

## What is tested

Forgejo (17.0.1): everything ran for real against a test repository: `description --append --compare`,
`comment --compare --composite`, `upload` of a GIF, PNG and MP4 attachments. The files arrive byte for byte (a
forge does not recompress), tables with `<br>` and links render.

OneDev and GitHub: lookups ran against real instances; the write paths (upload, comment, description, the branch
commits) are implemented from the API documentation and exercised with `--dry-run` and against a local fake
server only. Treat the first real write with each of them as a test: `--dry-run` first.

Files with the same content are uploaded once and linked twice (an unchanged before/after pair). Attachments
belong to the pull request's repository and go away with it; nothing else is stored on the forge.
