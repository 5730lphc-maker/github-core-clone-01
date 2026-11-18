import { ApiError, Store, required, type Json } from './store.ts';

interface Reply { status: number; body: unknown; headers?: Record<string, string> }
export function rest(store: Store, method: string, path: string, url: URL, body: Json): Reply {
  const ok = (body: unknown, status = 200): Reply => ({ status, body });
  const page = (items: any[]): Reply => {
    const size = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page')) || 30));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1), start = (page - 1) * size;
    const result = ok(items.slice(start, start + size));
    if (start + size < items.length) {
      const next = new URL(url.pathname + url.search, store.origin); next.searchParams.set('page', String(page + 1));
      result.headers = { link: `<${next.href}>; rel="next"` };
    }
    return result;
  };
  if (method === 'GET' && path === '/') return { status: 200, body: { current_user_url: `${store.origin}/api/v3/user`, repository_url: `${store.origin}/api/v3/repos/{owner}/{repo}` }, headers: { 'x-oauth-scopes': 'repo, read:org' } };
  if (method === 'GET' && path === '/meta') return ok({ installed_version: 'standalone-forge-1' });
  if (method === 'GET' && path === '/user') return ok(store.user);
  if (path === '/user/repos') {
    if (method === 'POST') return ok(store.createRepo(body).data, 201);
    if (method === 'GET') return page([...store.repos.values()].map(r => r.data));
  }
  const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match) throw new ApiError(404, 'Not Found');
  const repo = store.repo(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
  const tail = (match[3] || '').split('/').map(decodeURIComponent).join('/');
  const p = tail.split('/'), number = Number(p[1]);
  const query = (name: string) => url.searchParams.get(name) ?? undefined;
  if (!tail) {
    if (method === 'GET') return ok(repo.data);
    if (method === 'PATCH') {
      for (const key of ['description', 'default_branch', 'private', 'has_issues', 'archived']) if (body[key] !== undefined) repo.data[key] = body[key];
      return ok(repo.data);
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.data.name.toLowerCase());
      for (const [id, node] of store.nodes) if (node.repo === repo) store.nodes.delete(id);
      return ok(null, 204);
    }
  }
  if (p[0] === 'contents') {
    const file = tail.slice('contents'.length).replace(/^\//, '');
    if (method === 'GET') return ok(store.content(repo, file, query('ref')));
    if (method === 'PUT' || method === 'DELETE') return store.writeContent(repo, file, body, method === 'DELETE');
  }
  if (tail === 'git/refs' && method === 'POST') {
    const ref = required(body.ref, 'ref'), sha = required(body.sha, 'sha');
    if (!ref.startsWith('refs/') || !repo.objects.all.has(sha)) throw new ApiError(422, 'Invalid ref or object');
    if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return ok({ ref, object: { sha, type: repo.objects.all.get(sha)!.type } }, 201);
  }
  if ((tail.startsWith('git/ref/') || tail.startsWith('git/refs/')) && method === 'GET') {
    const ref = tail.replace(/^git\/refs?\//, 'refs/'), sha = repo.refs.get(ref);
    if (!sha) throw new ApiError(404, 'Not Found');
    return ok({ ref, object: { sha, type: repo.objects.all.get(sha)!.type } });
  }
  if (p[0] === 'branches' && method === 'GET') {
    const branches = [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false }));
    if (tail === 'branches') return page(branches);
    const branch = branches.find(b => b.name === tail.slice(9));
    if (!branch) throw new ApiError(404, 'Not Found');
    return ok(branch);
  }
  if (p[0] === 'commits' && method === 'GET') {
    const commitJson = (sha: string) => { const c = repo.objects.commit(sha); return { sha, commit: { message: c.message, tree: { sha: c.tree } }, parents: c.parents.map(sha => ({ sha })) }; };
    if (p[1]) { const sha = store.tip(repo, p.slice(1).join('/')); if (!sha) throw new ApiError(404, 'Not Found'); return ok(commitJson(sha)); }
    const tip = store.tip(repo, query('sha')), commits: Json[] = [], pending = tip ? [tip] : [], seen = new Set<string>();
    while (pending.length) { const sha = pending.shift()!; if (seen.has(sha)) continue; seen.add(sha); commits.push(commitJson(sha)); pending.push(...repo.objects.commit(sha).parents); }
    return page(commits);
  }
  if (p[0] === 'labels') {
    if (tail === 'labels' && method === 'POST') {
      const name = required(body.name, 'name');
      if (repo.labels.has(name)) throw new ApiError(422, 'Label already exists');
      const label = { id: store.nextId++, name, color: body.color || 'ededed', description: body.description || '' };
      repo.labels.set(name, label); return ok(label, 201);
    }
    if (tail === 'labels' && method === 'GET') return page([...repo.labels.values()]);
  }
  if (p[0] === 'issues') {
    if (tail === 'issues') {
      if (method === 'POST') return ok(store.createIssue(repo, body), 201);
      if (method === 'GET') return page(store.listIssues(repo, query('state') || 'open', query('direction') || 'desc', true));
    }
    const issue = repo.issues.get(number) ?? repo.pulls.get(number);
    if (!issue) throw new ApiError(404, 'Not Found');
    if (p.length === 2) {
      if (method === 'GET') return ok(issue);
      if (method === 'PATCH') {
        if (body.labels) {
          const labels = body.labels.map((n: string) => { const label = repo.labels.get(n); if (!label) throw new ApiError(422, `Label ${n} does not exist`); return label; });
          issue.labels = labels;
        }
        if (body.state && !['open', 'closed'].includes(body.state)) throw new ApiError(422, 'Invalid state');
        for (const key of ['title', 'body', 'state']) if (body[key] !== undefined) issue[key] = body[key];
        issue.closed_at = issue.state === 'closed' ? store.now : null;
        return ok(issue);
      }
    }
    if (p.length === 3 && p[2] === 'comments') {
      if (method === 'POST') return ok(store.addComment(repo, number, body), 201);
      if (method === 'GET') return page(repo.comments.get(number) || []);
    }
  }
  if (p[0] === 'pulls') {
    if (tail === 'pulls') {
      if (method === 'POST') return ok(store.createPull(repo, body), 201);
      if (method === 'GET') return page([...repo.pulls.values()].filter(p => query('state') === 'all' || p.state === (query('state') || 'open')).map(p => store.refreshPull(repo, p)));
    }
    const pull = repo.pulls.get(number);
    if (!pull) throw new ApiError(404, 'Not Found');
    if (p.length === 2 && method === 'GET') return ok(store.refreshPull(repo, pull));
    if (p.length === 3 && p[2] === 'files' && method === 'GET') return page(store.pullFiles(repo, pull));
    if (p.length === 3 && p[2] === 'merge' && method === 'PUT') return ok(store.mergePull(repo, number, body));
  }
  throw new ApiError(404, 'Not Found');
}
