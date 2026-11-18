import { Store, ApiError, type Json, type Repository } from './store.ts';

interface Field { name: string; alias: string; args: Json; children: Field[]; condition?: string; directives: { name: string; args: Json }[] }
interface Operation { kind: string; name: string; fields: Field[]; defaults: Json }
interface Document { operations: Operation[]; fragments: Map<string, Field> }

class Parser {
  tokens: string[]; index = 0;
  constructor(text: string) {
    this.tokens = [];
    const pattern = /\s+|#[^\n]*|,|\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{}|]/gy;
    let p = 0;
    while (p < text.length) {
      pattern.lastIndex = p;
      const match = pattern.exec(text);
      if (!match) throw new Error(`Unexpected character at ${p}`);
      p = pattern.lastIndex;
      if (!/^(?:\s|#|,)/.test(match[0])) this.tokens.push(match[0]);
    }
  }
  peek() { return this.tokens[this.index]; }
  take(expected?: string): string {
    const token = this.tokens[this.index++];
    if (token === undefined || expected !== undefined && token !== expected) throw new Error(`Expected ${expected || 'token'}, found ${token || 'end of document'}`);
    return token;
  }
  value(): any {
    const token = this.take();
    if (token === '$') return { variable: this.take() };
    if (token === '[') { const values: any[] = []; while (this.peek() !== ']') values.push(this.value()); this.take(']'); return values; }
    if (token === '{') { const value: Json = {}; while (this.peek() !== '}') { const key = this.take(); this.take(':'); value[key] = this.value(); } this.take('}'); return value; }
    if (token.startsWith('"')) return JSON.parse(token);
    if (/^-?\d/.test(token)) return Number(token);
    if (token === 'null') return null;
    if (token === 'true' || token === 'false') return token === 'true';
    return token;
  }
  args(): Json {
    const args: Json = {}; if (this.peek() !== '(') return args;
    this.take('('); while (this.peek() !== ')') { const key = this.take(); this.take(':'); args[key] = this.value(); } this.take(')'); return args;
  }
  directives() {
    const result: { name: string; args: Json }[] = [];
    while (this.peek() === '@') { this.take(); const name = this.take(); result.push({ name, args: this.args() }); }
    return result;
  }
  selection(): Field[] {
    this.take('{'); const fields: Field[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.take(); const name = this.take();
        if (name === 'on') {
          const condition = this.take(), directives = this.directives();
          fields.push({ name: '...', alias: '', args: {}, children: this.selection(), condition, directives });
        } else fields.push({ name: '...' + name, alias: '', args: {}, children: [], directives: this.directives() });
        continue;
      }
      let name = this.take(), alias = name;
      if (this.peek() === ':') { this.take(); name = this.take(); }
      const args = this.args(), directives = this.directives();
      const children = this.peek() === '{' ? this.selection() : [];
      fields.push({ name, alias, args, children, directives });
    }
    this.take('}'); return fields;
  }
  document(): Document {
    const operations: Operation[] = [], fragments = new Map<string, Field>();
    while (this.peek()) {
      if (this.peek() === 'fragment') {
        this.take(); const name = this.take(); this.take('on'); const condition = this.take(), directives = this.directives();
        fragments.set(name, { name: '...', alias: '', args: {}, children: this.selection(), condition, directives }); continue;
      }
      let kind = 'query', name = ''; const defaults: Json = {};
      if (this.peek() !== '{') {
        kind = this.take(); if (!['query', 'mutation'].includes(kind)) throw new Error(`Unknown operation ${kind}`);
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') name = this.take();
        if (this.peek() === '(') {
          this.take();
          while (this.peek() !== ')') {
            this.take('$'); const variable = this.take(); this.take(':');
            while (this.peek() && !['$', ')', '='].includes(this.peek())) this.take();
            if (this.peek() === '=') { this.take(); defaults[variable] = this.value(); }
          }
          this.take(')');
        }
      }
      this.directives(); operations.push({ kind, name, fields: this.selection(), defaults });
    }
    if (!operations.length) throw new Error('Query is required');
    return { operations, fragments };
  }
}

const schema: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { id: '', databaseId: '', name: '', nameWithOwner: '', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: '', hasIssuesEnabled: '', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest', description: '', url: '', isPrivate: '' },
  User: { id: '', login: '', name: '' }, Ref: { name: '', target: 'Commit' }, Commit: { oid: '', id: '' }, Node: { id: '' },
  Issue: { id: '', number: '', title: '', state: '', body: '', bodyText: '', createdAt: '', updatedAt: '', closedAt: '', url: '', labels: 'LabelConnection', comments: 'IssueCommentConnection' },
  PullRequest: { id: '', number: '', title: '', body: '', state: '', merged: '', headRefName: '', baseRefName: '', mergeable: '', files: 'PullRequestChangedFileConnection', url: '', createdAt: '' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: '' },
  IssueEdge: { node: 'Issue', cursor: '' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: '' },
  PullRequestEdge: { node: 'PullRequest', cursor: '' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo', totalCount: '' },
  PullRequestChangedFile: { path: '', additions: '', deletions: '', changeType: '' },
  PageInfo: { hasNextPage: '', hasPreviousPage: '', endCursor: '', startCursor: '' },
  LabelConnection: { nodes: 'Label', totalCount: '' }, Label: { name: '', color: '', id: '' },
  IssueCommentConnection: { nodes: 'IssueComment', totalCount: '' }, IssueComment: { id: '', body: '' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: '' }, CloseIssuePayload: { issue: 'Issue', clientMutationId: '' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: '' }, MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: '' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: '' }, IssueCommentEdge: { node: 'IssueComment' },
  __Type: { name: '', kind: '', fields: '__Field', enumValues: '__EnumValue', ofType: '__Type', description: '' },
  __Field: { name: '', description: '', type: '__Type', args: '__InputValue', isDeprecated: '', deprecationReason: '' },
  __EnumValue: { name: '', description: '', isDeprecated: '', deprecationReason: '' },
  __InputValue: { name: '', type: '__Type', defaultValue: '' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
};
const enums: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'], IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};
const cursor = (index: number) => Buffer.from(`cursor:${index}`).toString('base64');
function connection(items: any[], args: Json) {
  const offset = args.after ? Number(Buffer.from(args.after, 'base64').toString().split(':')[1]) + 1 : 0;
  const start = Number.isFinite(offset) ? Math.max(0, offset) : 0;
  const nodes = items.slice(start, start + Math.max(0, Math.min(100, args.first ?? 100)));
  return { nodes, totalCount: items.length, edges: nodes.map((node, i) => ({ node, cursor: cursor(start + i) })), pageInfo: { hasNextPage: start + nodes.length < items.length, hasPreviousPage: start > 0, endCursor: nodes.length ? cursor(start + nodes.length - 1) : null, startCursor: nodes.length ? cursor(start) : null } };
}
function expand(value: any, variables: Json): any {
  if (Array.isArray(value)) return value.map(v => expand(v, variables));
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.variable === 'string') return variables[value.variable];
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, variables)]));
  }
  return value;
}

export function graphql(store: Store, input: any): any {
  if (Array.isArray(input)) return input.map(operation => graphql(store, operation));
  try {
    if (!input || typeof input.query !== 'string') throw new Error('query must be a string');
    const doc = new Parser(input.query).document();
    const operation = input.operationName ? doc.operations.find(o => o.name === input.operationName) : doc.operations.length === 1 ? doc.operations[0] : undefined;
    if (!operation) throw new Error('An operationName is required for multiple operations');
    const vars = { ...operation.defaults, ...input.variables };
    const root = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const validate = (type: string, fields: Field[], stack = new Set<string>()) => {
      for (const field of fields) {
        if (field.name.startsWith('...')) {
          if (field.name !== '...') {
            const name = field.name.slice(3), fragment = doc.fragments.get(name);
            if (!fragment || stack.has(name)) throw new Error(`Invalid fragment ${name}`);
            validate(fragment.condition!, fragment.children, new Set([...stack, name]));
          } else validate(field.condition!, field.children, stack);
          continue;
        }
        if (field.name === '__typename') continue;
        if (!Object.hasOwn(schema[type] || {}, field.name)) throw new Error(`Cannot query field "${field.name}" on type "${type}".`);
        const childType = schema[type][field.name];
        if (field.children.length && childType) validate(childType, field.children, stack);
      }
    };
    validate(root, operation.fields);
    const node = (id: string, type?: string) => {
      const result = store.nodes.get(id);
      if (!result || type && result.type !== type) throw new Error('Node not found');
      return result;
    };
    const repoNode = (id: string): Repository => node(id, 'Repository').repo;
    const locate = (obj: Json): Repository => node(obj.node_id).repo;
    const resolve = (type: string, obj: any, name: string, args: Json): any => {
      if (name === '__typename') return type;
      if (type === 'Query') {
        if (name === 'viewer') return store.user;
        if (name === 'repository') return store.findRepo(args.owner, args.name) ?? null;
        if (name === 'node') { const item = store.nodes.get(args.id); return item ? { actualType: item.type, value: item.value } : null; }
        if (name === '__type') return schema[args.name] || enums[args.name] ? { name: args.name, kind: enums[args.name] ? 'ENUM' : 'OBJECT' } : null;
        if (name === '__schema') return { types: [...Object.keys(schema), ...Object.keys(enums)].map(name => ({ name, kind: enums[name] ? 'ENUM' : 'OBJECT' })), queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      }
      if (type === 'Mutation') {
        const value = args.input || {};
        if (name === 'createIssue') return { issue: store.createIssue(repoNode(value.repositoryId), value), clientMutationId: value.clientMutationId ?? null };
        if (name === 'closeIssue') { const item = node(value.issueId, 'Issue'); item.value.state = 'closed'; item.value.closed_at = store.now; return { issue: item.value }; }
        if (name === 'createPullRequest') return { pullRequest: store.createPull(repoNode(value.repositoryId), { ...value, head: value.headRefName, base: value.baseRefName }) };
        if (name === 'mergePullRequest') { const item = node(value.pullRequestId, 'PullRequest'); store.mergePull(item.repo, item.value.number, {}); return { pullRequest: item.value }; }
        if (name === 'addComment') { const item = node(value.subjectId); return { commentEdge: { node: store.addComment(item.repo, item.value.number, value) } }; }
      }
      if (type === 'Repository') {
        const repo = obj as Repository, d = repo.data;
        if (name === 'id') return d.node_id;
        if (name === 'databaseId') return d.id;
        if (name === 'nameWithOwner') return d.full_name;
        if (name === 'owner') return store.user;
        if (name === 'defaultBranchRef') return repo.refs.has(`refs/heads/${d.default_branch}`) ? { name: d.default_branch, target: { oid: store.tip(repo) } } : null;
        if (name === 'viewerPermission') return 'ADMIN';
        if (name === 'hasIssuesEnabled') return d.has_issues;
        if (name === 'isPrivate') return d.private;
        if (name === 'url') return d.html_url;
        if (name === 'issue') return repo.issues.get(args.number) ?? null;
        if (name === 'pullRequest') { const p = repo.pulls.get(args.number); return p ? store.refreshPull(repo, p) : null; }
        if (name === 'issues') {
          let list = store.listIssues(repo, 'all', args.orderBy?.direction === 'ASC' ? 'asc' : 'desc');
          if (args.states) list = list.filter(i => args.states.includes(i.state.toUpperCase()));
          return connection(list, args);
        }
        if (name === 'pullRequests') {
          let list = [...repo.pulls.values()].map(p => store.refreshPull(repo, p));
          if (args.states) list = list.filter(p => args.states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
          return connection(list, args);
        }
        return d[name] ?? null;
      }
      if (type === 'Issue' || type === 'PullRequest') {
        if (name === 'id') return obj.node_id;
        if (name === 'state') return obj.merged ? 'MERGED' : obj.state.toUpperCase();
        if (name === 'bodyText') return obj.body;
        if (name === 'url') return obj.html_url;
        if (name === 'headRefName') return obj.head.ref;
        if (name === 'baseRefName') return obj.base.ref;
        if (name === 'mergeable') return obj.mergeable === false ? 'CONFLICTING' : 'MERGEABLE';
        if (name === 'files') return connection(store.pullFiles(locate(obj), obj), args);
        if (name === 'comments') return connection(locate(obj).comments.get(obj.number) || [], args);
        if (name === 'labels') return connection(obj.labels, args);
        if (name === 'createdAt') return obj.created_at;
        if (name === 'updatedAt') return obj.updated_at;
        if (name === 'closedAt') return obj.closed_at;
      }
      if (type === 'IssueComment' && name === 'id') return obj.node_id;
      if (type === 'User' && name === 'id') return Buffer.from(`User:${obj.id}`).toString('base64');
      if (type === '__Type') {
        if (name === 'fields') return schema[obj.name] ? Object.entries(schema[obj.name]).map(([name, type]) => ({ name, type: { name: type || 'String', kind: type ? 'OBJECT' : 'SCALAR' }, args: [], isDeprecated: false, deprecationReason: null })) : null;
        if (name === 'enumValues') return enums[obj.name]?.map(name => ({ name, isDeprecated: false, deprecationReason: null })) ?? null;
      }
      return obj[name] ?? null;
    };
    const execute = (type: string, obj: any, fields: Field[]): any => {
      if (obj == null) return null;
      if (Array.isArray(obj)) return obj.map(o => execute(type, o, fields));
      if (type === 'Node') { type = obj.actualType; obj = obj.value; }
      const result: Json = {};
      for (const field of fields) {
        if (field.directives.some(d => d.name === 'skip' && expand(d.args, vars).if === true || d.name === 'include' && expand(d.args, vars).if === false)) continue;
        if (field.name.startsWith('...')) {
          const fragment = field.name === '...' ? field : doc.fragments.get(field.name.slice(3))!;
          if (fragment.condition === type || fragment.condition === 'Node') Object.assign(result, execute(type, obj, fragment.children));
          continue;
        }
        const value = resolve(type, obj, field.name, expand(field.args, vars));
        const childType = schema[type]?.[field.name];
        result[field.alias] = field.children.length && childType ? execute(childType, value, field.children) : value;
      }
      return result;
    };
    return { data: execute(root, {}, operation.fields) };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL execution error' }] };
  }
}
