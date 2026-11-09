export class CommandRejectedError extends Error {
  readonly status:number;
  constructor(message:string,status:number){super(message);this.name='CommandRejectedError';this.status=status;}
}
export function isConfirmedCommandRejection(error:unknown):boolean {
  return error instanceof CommandRejectedError || error instanceof Error && error.cause instanceof Error && isConfirmedCommandRejection(error.cause);
}
