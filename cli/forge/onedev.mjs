// OneDev. `api` is the REST base (https://host/~api, or a proxy that maps to it); `url` is the optional web base
// for links to the pull request.
//
// Attachments (PullRequestResource.uploadAttachment, OneDev 12+):
//   POST /pulls/<global id>/attachments/<preferred name>, Content-Type application/octet-stream, raw bytes
//   -> text/plain "/~downloads/projects/<project id>/attachments/<pull request uuid>/<name>"
// Markdown in the description or a comment of that pull request references this server-relative URL.
import fs from 'node:fs';
import { authHeaders, createClient } from './http.mjs';

export function create(forge, { dryRun }) {
  if (!forge.api) throw new Error(`forge "${forge.name}": "api" is missing (the OneDev REST base, https://host/~api)`);
  const api = createClient({ base: forge.api, auth: () => authHeaders(forge), dryRun });
  const web = forge.url?.replace(/\/+$/, '');

  const describe = (pull, projectPath) => ({
    id: pull.id, number: pull.number, repo: projectPath ?? String(pull.targetProjectId), title: pull.title,
    url: web && projectPath ? `${web}/${projectPath}/~pulls/${pull.number}` : null,
    projectId: pull.targetProjectId, uuid: pull.uuid, description: pull.description ?? '',
  });

  return {
    // repo: project path or id; number: the number shown in the UI; id: OneDev's global pull request id
    async resolve({ repo, number, id }) {
      if (id) return describe(await api.get(`/pulls/${Number(id)}`), repo);
      if (!repo || !number) {
        throw new Error('needs --repo <project path|id> and --pr <number> (or --pr-id <global id>)');
      }
      const project = /^\d+$/.test(repo)
        ? await api.get(`/projects/${repo}`)
        : (await api.get('/projects', { query: `"Path" is "${repo}"`, offset: 0, count: 2 }))[0];
      if (!project) throw new Error(`OneDev project not found: ${repo}`);
      const pulls = await api.get('/pulls', {
        query: `"Target Project" is "${project.path}" and "Number" is "${number}"`, offset: 0, count: 2,
      });
      const wanted = candidate => candidate.number === Number(number) && candidate.targetProjectId === project.id;
      const pull = pulls.find(wanted);
      if (!pull) throw new Error(`pull request #${number} not found in ${project.path}`);
      return describe(pull, project.path);
    },

    // OneDev stores the name it was given unless it is taken; the answer carries the real one.
    async uploadImage(pr, file, name) {
      const answer = await api.write('POST', `/pulls/${pr.id}/attachments/${encodeURIComponent(name)}`, {
        body: fs.readFileSync(file), contentType: 'application/octet-stream', note: file,
      });
      if (answer === null) {
        const base = `/~downloads/projects/${pr.projectId}/attachments/${pr.uuid}`;
        return { markdownUrl: `${base}/${encodeURIComponent(name)}` };
      }
      const url = String(answer).trim();
      if (!url.startsWith('/')) throw new Error(`unexpected upload answer for ${file}: ${url.slice(0, 200)}`);
      return { markdownUrl: url };
    },

    async comment(pr, markdown) {
      const user = await api.get('/users/me');
      const answer = await api.write('POST', '/pull-request-comments', {
        json: { requestId: pr.id, userId: user.id, content: markdown, date: new Date().toISOString() },
      });
      return { url: pr.url, id: answer === null ? null : Number(answer) };
    },

    async getDescription(pr) {
      return pr.description;
    },

    async setDescription(pr, markdown) {
      // OneDev reads this body as the raw text, although it insists on the JSON content type.
      await api.write('POST', `/pulls/${pr.id}/description`, { body: markdown, contentType: 'application/json' });
      return { url: pr.url };
    },
  };
}
