// Image hosting for forges without an upload API: the files are committed to a dedicated branch of the repository
// and linked by their raw URL. The branch is an orphan (no shared history with the code) and is created on first
// use; every upload is one commit on top of it.
//
// git: the forge's git data calls, so the strategy is not tied to one provider:
//   getRef(branch)                      -> commit sha | null
//   getCommit(sha)                      -> {tree}
//   createBlob(buffer)                  -> sha
//   createTree(entries, baseTree|null)  -> sha        entries: [{path, sha}]
//   createCommit(message, tree, parents) -> sha
//   createRef(branch, sha) / updateRef(branch, sha)
// In a dry run the write calls return null; placeholders stand in for the ids they would have returned.
import fs from 'node:fs';

export async function commitFiles(git, { branch, files, message }) {
  const head = await git.getRef(branch);
  const baseTree = head ? (await git.getCommit(head)).tree : null;
  const entries = [];
  for (const { path, file } of files) {
    entries.push({ path, sha: (await git.createBlob(fs.readFileSync(file), file)) ?? '<blob sha>' });
  }
  const tree = (await git.createTree(entries, baseTree)) ?? '<tree sha>';
  const commit = (await git.createCommit(message, tree, head ? [head] : [])) ?? '<commit sha>';
  if (head) await git.updateRef(branch, commit);
  else await git.createRef(branch, commit);
  return { branch, commit, created: !head };
}
