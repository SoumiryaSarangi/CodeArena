import { Server } from '@hocuspocus/server';

export const createServer = (port: number) => new Server({ port, name: 'collab' });
