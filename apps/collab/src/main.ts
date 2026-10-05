import { createServer } from './server';

await createServer(Number(process.env.PORT ?? 1234)).listen();
