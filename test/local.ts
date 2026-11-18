import { createApp } from '../app.ts';
import { installTransport } from './transport.ts';
process.env.MAKEFUN_SHOP_TOKEN = 'local-test-token';
const transport = installTransport(createApp());
process.argv = ['node', 'run.ts', '--url', 'http://entry.local:34567', '--token', process.env.MAKEFUN_SHOP_TOKEN, ...process.argv.slice(2)];
await import('../../kit/github-core-clone-01-kit/sdk/run.ts');
transport.close();
