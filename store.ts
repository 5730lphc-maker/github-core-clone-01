import { Objects } from './objects.ts';

export type Json = Record<string, any>;
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const required = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(422, `${field} is required`);
  return value;
};
export const globalId = (type: string, id: number): string => Buffer.from(`${type}:${id}`).toString('base64');
export interface Repository {
  data: Json;
  objects: Objects;
  refs: Map<string, string>;
  labels: Map<string, Json>;
  issues: Map<number, Json>;
  pulls: Map<number, Json>;
  comments: Map<number, Json[]>;
  nextNumber: number;
  packs: Map<string, Buffer>;
}

/** A token owns one namespace. With an opaque token and no login configuration,
 * its namespace is established by its first authenticated repository path. */
export class Store {
  repos = new Map<string, Repository>();
  nodes = new Map<string, { type: string; value: any; repo: Repository }>();
  owner = process.env.MAKEFUN_LOGIN ?? '';
  user: Json = { login: this.owner || 'forge', id: 1, type: 'User' };
  nextId = 1;
  now = process.env.MAKEFUN_TRIAL_NOW || '2026-01-01T00:00:00Z';
  epoch = Math.floor(Date.parse(this.now) / 1000) || 1767225600;
  origin = '';
  setOwner(owner: string) {
    if (this.owner) return;
    this.owner = owner; this.user.login = owner;
    for (const repo of this.repos.values()) this.decorate(repo);
  }
  decorate(repo: Repository) {
    const d = repo.data, full = `${this.user.login}/${d.name}`;
    Object.assign(d, { full_name: full, owner: this.user, url: `${this.origin}/api/v3/repos/${full}`, html_url: `${this.origin}/${full}`, clone_url: `${this.origin}/${full}.git`, git_url: `${this.origin}/${full}.git` });
  }
  createRepo(input: Json): Repository {
    const name = required(input.name, 'name');
    if (!/^[\w.-]+$/.test(name)) throw new ApiError(422, 'Invalid repository name');
    if (this.repos.has(name.toLowerCase())) throw new ApiError(422, 'Repository already exists');
    const id = this.nextId++;
    const repo: Repository = { data: { id, node_id: globalId('Repository', id), name, private: !!input.private, description: input.description ?? '', default_branch: input.default_branch || 'main', created_at: this.now, updated_at: this.now, has_issues: true, archived: false }, objects: new Objects(), refs: new Map(), labels: new Map(), issues: new Map(), pulls: new Map(), comments: new Map(), nextNumber: 1, packs: new Map() };
    this.decorate(repo);
    this.repos.set(name.toLowerCase(), repo);
    this.nodes.set(repo.data.node_id, { type: 'Repository', value: repo, repo });
    if (input.auto_init) {
      const blob = repo.objects.put('blob', Buffer.from(`# ${name}\n`));
      const tree = repo.objects.buildTree(new Map([['README.md', { oid: blob, mode: '100644' }]]));
      repo.refs.set(`refs/heads/${repo.data.default_branch}`, repo.objects.createCommit(tree, [], 'Initial commit', this.epoch));
    }
    return repo;
  }
  findRepo(owner: string, name: string): Repository | undefined {
    const repo = this.repos.get(name.toLowerCase());
    if (repo && !this.owner) this.setOwner(owner);
    return owner.toLowerCase() === this.owner.toLowerCase() ? repo : undefined;
  }
  repo(owner: string, name: string): Repository {
    const repo = this.findRepo(owner, name);
    if (!repo) throw new ApiError(404, 'Not Found');
    return repo;
  }
  tip(repo: Repository, ref?: string): string | undefined {
    return repo.refs.get(ref || `refs/heads/${repo.data.default_branch}`) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? (ref && repo.objects.all.has(ref) ? repo.objects.peel(ref) : undefined);
  }
  content(repo: Repository, path: string, ref?: string): Json | Json[] {
    const tip = this.tip(repo, ref);
    if (!tip) throw new ApiError(404, 'Not Found');
    const files = repo.objects.files(tip), entry = files.get(path);
    const describe = (path: string, oid: string, type = 'file'): Json => ({ name: path.split('/').pop(), path, sha: oid, size: repo.objects.all.get(oid)?.data.length ?? 0, type, encoding: 'base64', content: type === 'file' ? repo.objects.all.get(oid)?.data.toString('base64') : undefined });
    if (entry) return describe(path, entry.oid);
    let tree = repo.objects.commit(tip).tree;
    if (path) for (const segment of path.split('/')) {
      const e = repo.objects.tree(tree).find(e => e.name === segment && /^(0?40000)$/.test(e.mode));
      if (!e) throw new ApiError(404, 'Not Found');
      tree = e.oid;
    }
    return repo.objects.tree(tree).map(e => describe((path ? path + '/' : '') + e.name, e.oid, /^(0?40000)$/.test(e.mode) ? 'dir' : 'file'));
  }
  writeContent(repo: Repository, path: string, input: Json, remove = false): { status: number; body: Json } {
    const branch = input.branch || repo.data.default_branch, ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    if (!parent && repo.refs.size && input.branch) throw new ApiError(404, 'Branch not found');
    const files = repo.objects.files(parent), old = files.get(path);
    if (remove && !old) throw new ApiError(404, 'Not Found');
    if (old && input.sha !== old.oid || !old && input.sha) throw new ApiError(409, 'Content sha does not match');
    if (!path || path.split('/').some(p => !p || p === '.' || p === '..')) throw new ApiError(422, 'Invalid path');
    let oid: string | undefined;
    if (remove) files.delete(path);
    else {
      if (typeof input.content !== 'string') throw new ApiError(422, 'content is required');
      oid = repo.objects.put('blob', Buffer.from(input.content, 'base64'));
      files.set(path, { oid, mode: old?.mode || '100644' });
    }
    const tree = repo.objects.buildTree(files);
    const sha = repo.objects.createCommit(tree, parent ? [parent] : [], input.message || (remove ? `Delete ${path}` : `Update ${path}`), this.epoch);
    repo.refs.set(ref, sha); repo.packs.clear();
    return { status: old || remove ? 200 : 201, body: { content: remove ? null : this.content(repo, path, branch), commit: { sha, message: input.message || '', parents: parent ? [{ sha: parent }] : [] } } };
  }
  createIssue(repo: Repository, input: Json, pull = false): Json {
    const title = required(input.title, 'title');
    const labels = (input.labels || []).map((label: any) => {
      const name = typeof label === 'string' ? label : label.name;
      if (!repo.labels.has(name)) throw new ApiError(422, `Label ${name} does not exist`);
      return repo.labels.get(name);
    });
    const id = this.nextId++, number = repo.nextNumber++, type = pull ? 'PullRequest' : 'Issue';
    const item: Json = { id, node_id: globalId(type, id), number, title, body: input.body ?? '', state: 'open', labels, user: this.user, created_at: this.now, updated_at: this.now, closed_at: null, comments: 0, url: `${repo.data.url}/issues/${number}`, html_url: `${repo.data.html_url}/issues/${number}` };
    (pull ? repo.pulls : repo.issues).set(number, item);
    this.nodes.set(item.node_id, { type, value: item, repo });
    return item;
  }
  listIssues(repo: Repository, state = 'open', direction = 'desc', includePulls = false): Json[] {
    return [...repo.issues.values(), ...(includePulls ? [...repo.pulls.values()] : [])].filter(i => state === 'all' || i.state === state).sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
  }
  addComment(repo: Repository, number: number, input: Json): Json {
    const item = repo.issues.get(number) ?? repo.pulls.get(number);
    if (!item) throw new ApiError(404, 'Not Found');
    const id = this.nextId++;
    const comment = { id, node_id: globalId('IssueComment', id), body: required(input.body, 'body'), user: this.user, created_at: this.now, updated_at: this.now };
    const list = repo.comments.get(number) ?? []; list.push(comment); repo.comments.set(number, list); item.comments++;
    return comment;
  }
  createPull(repo: Repository, input: Json): Json {
    const head = required(input.head, 'head').split(':').pop()!, base = required(input.base, 'base');
    const headSha = this.tip(repo, head), baseSha = this.tip(repo, base);
    if (!headSha || !baseSha) throw new ApiError(422, 'Head or base branch not found');
    const item = this.createIssue(repo, input, true);
    Object.assign(item, { head: { ref: head, sha: headSha, repo: repo.data }, base: { ref: base, sha: baseSha, repo: repo.data }, merged: false, merged_at: null, merge_commit_sha: null, mergeable: true, pull_request: { url: `${repo.data.url}/pulls/${item.number}` } });
    return item;
  }
  refreshPull(repo: Repository, pull: Json): Json {
    if (!pull.merged) {
      pull.head.sha = this.tip(repo, pull.head.ref) ?? pull.head.sha;
      pull.base.sha = this.tip(repo, pull.base.ref) ?? pull.base.sha;
    }
    return pull;
  }
  mergeBase(repo: Repository, a: string, b: string): string | undefined {
    const ancestors = new Set<string>(), pending = [a];
    while (pending.length) { const oid = pending.pop()!; if (ancestors.has(oid)) continue; ancestors.add(oid); pending.push(...repo.objects.commit(oid).parents); }
    const queue = [b], seen = new Set<string>();
    for (let i = 0; i < queue.length; i++) { const oid = queue[i]; if (ancestors.has(oid)) return oid; if (seen.has(oid)) continue; seen.add(oid); queue.push(...repo.objects.commit(oid).parents); }
  }
  pullFiles(repo: Repository, pull: Json): Json[] {
    this.refreshPull(repo, pull);
    const base = this.mergeBase(repo, pull.base.sha, pull.head.sha);
    const before = repo.objects.files(base), after = repo.objects.files(pull.head.sha), result: Json[] = [];
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(path), b = after.get(path);
      if (a?.oid === b?.oid) continue;
      const lines = (oid?: string) => oid ? repo.objects.all.get(oid)!.data.toString().split('\n').filter(Boolean).length : 0;
      const additions = lines(b?.oid), deletions = lines(a?.oid);
      result.push({ filename: path, path, sha: b?.oid || a?.oid, status: !a ? 'added' : !b ? 'removed' : 'modified', additions, deletions, changes: additions + deletions });
    }
    return result;
  }
  mergePull(repo: Repository, number: number, input: Json = {}): Json {
    const pull = repo.pulls.get(number);
    if (!pull) throw new ApiError(404, 'Not Found');
    if (pull.merged || pull.state !== 'open') throw new ApiError(405, 'Pull request is not open');
    this.refreshPull(repo, pull);
    if (input.sha && input.sha !== pull.head.sha) throw new ApiError(409, 'Head sha does not match');
    const common = this.mergeBase(repo, pull.base.sha, pull.head.sha);
    const ancestor = repo.objects.files(common), current = repo.objects.files(pull.base.sha), head = repo.objects.files(pull.head.sha);
    for (const path of new Set([...ancestor.keys(), ...head.keys()])) {
      const a = ancestor.get(path), b = head.get(path), c = current.get(path);
      if (a?.oid === b?.oid) continue;
      if (c?.oid !== a?.oid && c?.oid !== b?.oid) { pull.mergeable = false; throw new ApiError(405, 'Pull request is conflicted'); }
      if (b) current.set(path, b); else current.delete(path);
    }
    const tree = repo.objects.buildTree(current);
    const sha = repo.objects.createCommit(tree, [pull.base.sha], input.commit_title || `${pull.title} (#${number})`, this.epoch);
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha); repo.packs.clear();
    Object.assign(pull, { merged: true, state: 'closed', merged_at: this.now, closed_at: this.now, merge_commit_sha: sha });
    return { sha, merged: true, message: 'Pull Request successfully merged' };
  }
}
