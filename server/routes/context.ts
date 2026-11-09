import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Workspace } from '../../shared/types.ts';

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  workspace: Workspace;
  send(status: number, body: unknown): void;
  sendJson(status: number, json: string): void;
}
