// GitHub (github.com or GitHub Enterprise: set `api` to https://host/api/v3 and `url` to https://host).
// Comments and the description go through the REST API. GitHub has no API for comment attachments, so images are
// committed to a dedicated branch (git-ref.mjs) and linked by their raw URL.
import { commitFiles } from './git-ref.mjs';
import { authHeaders, createClient } from './http.mjs';

export function create(forge, { dryRun }) {
  const api = createClient({
    base: forge.api ?? 'https://api.github.com',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    auth: () => authHeaders(forge, 'Bearer'),
    dryRun,
  });
  const web = (forge.url ?? 'https://github.com').replace(/\/+$/, '');
  const branch = forge.assetsBranch ?? 'agent-lens-assets';

  const gitData = repo => ({
    getRef: async name => (await api.find(`/repos/${repo}/git/ref/heads/${name}`))?.object?.sha ?? null,
    getCommit: async sha => ({ tree: (await api.get(`/repos/${repo}/git/commits/${sha}`)).tree.sha }),
    createBlob: async (data, note) => (await api.write('POST', `/repos/${repo}/git/blobs`, {
      // printed in a dry run, so the base64 text is not built there
      json: dryRun ? { content: `<base64 of ${note}, ${data.length} bytes>`, encoding: 'base64' }
        : { content: data.toString('base64'), encoding: 'base64' },
    }))?.sha,
    createTree: async (entries, baseTree) => (await api.write('POST', `/repos/${repo}/git/trees`, {
      json: {
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: entries.map(entry => ({ path: entry.path, mode: '100644', type: 'blob', sha: entry.sha })),
      },
    }))?.sha,
    createCommit: async (message, tree, parents) => (await api.write('POST', `/repos/${repo}/git/commits`, {
      json: { message, tree, parents },
    }))?.sha,
    createRef: (name, sha) => api.write('POST', `/repos/${repo}/git/refs`, {
      json: { ref: `refs/heads/${name}`, sha },
    }),
    updateRef: (name, sha) => api.write('PATCH', `/repos/${repo}/git/refs/heads/${name}`, { json: { sha } }),
  });

  const provider = {
    // repo: owner/name
    async resolve({ repo, number }) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo ?? '') || !number) {
        throw new Error('needs --repo <owner/name> and --pr <number>');
      }
      const pull = await api.get(`/repos/${repo}/pulls/${Number(number)}`);
      return {
        id: pull.id, number: pull.number, repo, title: pull.title, url: pull.html_url, description: pull.body ?? '',
      };
    },

    async uploadImages(pr, files) {
      const placed = files.map(({ file, name }) => ({ file, path: `pr-${pr.number}/${name}` }));
      await commitFiles(gitData(pr.repo), {
        branch, files: placed, message: `Images for pull request #${pr.number}`,
      });
      const encode = filePath => filePath.split('/').map(encodeURIComponent).join('/');
      return placed.map(({ path }) => ({ markdownUrl: `${web}/${pr.repo}/blob/${branch}/${encode(path)}?raw=true` }));
    },

    async uploadImage(pr, file, name) {
      return (await provider.uploadImages(pr, [{ file, name }]))[0];
    },

    async comment(pr, markdown) {
      const answer = await api.write('POST', `/repos/${pr.repo}/issues/${pr.number}/comments`, {
        json: { body: markdown },
      });
      return { url: answer?.html_url ?? pr.url };
    },

    async getDescription(pr) {
      return pr.description;
    },

    async setDescription(pr, markdown) {
      await api.write('PATCH', `/repos/${pr.repo}/pulls/${pr.number}`, { json: { body: markdown } });
      return { url: pr.url };
    },
  };
  return provider;
}
