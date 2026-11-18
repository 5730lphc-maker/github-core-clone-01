import { ApiError, Store, type Json } from './store.ts';

const string = { type: 'string' };
function tool(name: string, description: string, properties: Json, required: string[]) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
const scope = { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } };
export const TOOLS = [
  tool('create_repo', 'Create a repository owned by the authenticated user.', { name: string, description: string, private: { type: 'boolean' }, auto_init: { type: 'boolean' } }, ['name']),
  tool('get_repo', 'Read repository metadata, including its stable identifier and default branch.', scope, ['owner', 'repo']),
  tool('create_issue', 'Create an open issue in a repository.', { ...scope, title: string, body: string, labels: { type: 'array', items: string } }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List repository issues, optionally filtering by open, closed, or all states.', { ...scope, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from an existing head branch into a base branch.', { ...scope, title: string, body: string, head: string, base: string }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash merge a pull request, updating its base branch and closing the pull.', { ...scope, pull_number: { type: 'integer', minimum: 1 }, merge_method: { type: 'string', enum: ['squash'] } }, ['owner', 'repo', 'pull_number']),
];
const SUPPORTED = ['2026-07-28', '2025-11-25'];
const info = { name: 'standalone-forge', version: '1.0.0' };
export const rpcError = (id: any, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function mcp(store: Store, request: any): { status: number; body: any } {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return { status: 200, body: rpcError(request?.id, -32600, 'Invalid Request') };
  const id = request.id;
  const answer = (result: any) => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const error = (code: number, message: string) => ({ status: 200, body: rpcError(id, code, message) });
  if (id === undefined) return { status: 202, body: null };
  switch (request.method) {
    case 'server/discover': return answer({ serverInfo: info, capabilities: { tools: { listChanged: false } }, supportedVersions: SUPPORTED });
    case 'initialize': return answer({ protocolVersion: SUPPORTED.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-11-25', serverInfo: info, capabilities: { tools: { listChanged: false } } });
    case 'ping': return answer({});
    case 'tools/list': return answer({ tools: TOOLS });
    case 'tools/call': {
      const params = request.params;
      if (!params || typeof params.name !== 'string') return error(-32602, 'Tool name is required');
      const normalized = params.name.toLowerCase();
      const spec = TOOLS.find(t => normalized === t.name || normalized.endsWith('__' + t.name));
      if (!spec) return error(-32602, `Unknown tool: ${params.name}`);
      const args = params.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return error(-32602, 'Tool arguments must be an object');
      for (const name of spec.inputSchema.required) {
        if (args[name] === undefined || args[name] === null || args[name] === '') return error(-32602, `Missing required argument: ${name}`);
      }
      for (const [name, value] of Object.entries(args)) {
        const schema = spec.inputSchema.properties[name];
        if (!schema) return error(-32602, `Unknown argument: ${name}`);
        if (schema.type === 'integer' ? !Number.isInteger(value) || Number(value) < (schema.minimum ?? -Infinity) : schema.type === 'array' ? !Array.isArray(value) : typeof value !== schema.type) return error(-32602, `Invalid argument: ${name}`);
        if (schema.enum && !schema.enum.includes(value)) return error(-32602, `Invalid argument: ${name}`);
      }
      try {
        let result: any;
        if (spec.name === 'create_repo') result = store.createRepo(args).data;
        else {
          const repo = store.repo(args.owner, args.repo);
          switch (spec.name) {
            case 'get_repo': result = repo.data; break;
            case 'create_issue': result = store.createIssue(repo, args); break;
            case 'list_issues': result = store.listIssues(repo, args.state || 'open'); break;
            case 'create_pull_request': result = store.createPull(repo, args); break;
            case 'merge_pull_request': result = store.mergePull(repo, args.pull_number, args); break;
          }
        }
        return answer({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
      } catch (err) {
        return answer({ content: [{ type: 'text', text: err instanceof Error ? err.message : 'Tool failed' }], isError: true });
      }
    }
    default: return error(-32601, `Method not found: ${request.method}`);
  }
}
