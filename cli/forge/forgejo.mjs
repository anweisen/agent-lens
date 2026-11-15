// Forgejo and Gitea. `api` is https://host/api/v1. Endpoints as in the instance's swagger (/swagger.v1.json):
//   GET   /repos/{owner}/{repo}/pulls/{index}
//   POST  /repos/{owner}/{repo}/issues/{index}/assets    multipart field "attachment", query name -> Attachment
//   POST  /repos/{owner}/{repo}/issues/{index}/comments  {body}
//   PATCH /repos/{owner}/{repo}/pulls/{index}            {body}
// An issue attachment answers with browser_download_url, which works in any comment of the repository.
import fs from 'node:fs';
import { authHeaders, createClient } from './http.mjs';

export function create(forge, { dryRun }) {
  if (!forge.api) throw new Error(`forge "${forge.name}": "api" is missing (https://host/api/v1)`);
  // API tokens are sent as "token <value>"
  const api = createClient({ base: forge.api, headers: { Accept: 'application/json' },
    auth: () => authHeaders(forge, 'token'), dryRun });
  const web = forge.api.replace(/\/+$/, '').replace(/\/api\/v1$/, '');

  return {
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

    async uploadImage(pr, file, name) {
      const form = new FormData();
      const types = { '.png': 'image/png', '.gif': 'image/gif', '.wav': 'audio/wav', '.mp4': 'video/mp4' };
      const type = types[name.slice(name.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';
      form.append('attachment', new Blob([fs.readFileSync(file)], { type }), name);
      const apiPath = `/repos/${pr.repo}/issues/${pr.number}/assets?${new URLSearchParams({ name })}`;
      const answer = await api.write('POST', apiPath, { body: form, note: file });
      if (answer === null) return { markdownUrl: `${web}/attachments/<uuid of ${name}>` };
      if (!answer.browser_download_url) {
        throw new Error(`unexpected upload answer for ${file}: ${JSON.stringify(answer).slice(0, 200)}`);
      }
      return { markdownUrl: answer.browser_download_url };
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
}
