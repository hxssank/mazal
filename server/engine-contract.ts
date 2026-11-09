export class EngineError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface EngineTransport { request(path: string, method?: string, body?: unknown): Promise<unknown>; download?(path: string): Promise<Response> }
