import type { AppState, Command, Workspace } from '../../shared/types.ts';
import { matchesCategoryChange } from '../../shared/category-review.ts';

export class CommandRecoveryError extends Error {
  readonly refreshedState:AppState|null;
  constructor(error:unknown,refreshedState:AppState|null) {
    super(error instanceof Error?error.message:'Could not save the change.',{cause:error});
    this.name='CommandRecoveryError';this.refreshedState=refreshedState;
  }
}

export async function executeCommandWithRecovery(workspace:Workspace,command:Command,send:(workspace:Workspace,command:Command)=>Promise<AppState>,load:(workspace:Workspace)=>Promise<AppState>,accept:(state:AppState)=>void):Promise<AppState> {
  try { return await send(workspace,command); }
  catch(error) {
    let refreshed:AppState|null=null;
    try { refreshed=await load(workspace);accept(refreshed); } catch {}
    const changes=command.type==='categorize_transactions'?command.changes:command.type==='categorize_transaction'?[command]:[];
    const annotated=command.type==='annotate_transaction'?refreshed?.transactions.find(row=>row.id===command.id):undefined;
    const annotationMatches=command.type==='annotate_transaction'&&!!annotated&&(annotated.displayName??null)===(command.displayName?.trim()||null)&&(annotated.note??null)===(command.note?.trim()||null);
    if(refreshed&&(annotationMatches||changes.length&&changes.every(change=>matchesCategoryChange(refreshed!.transactions.find(row=>row.id===change.id),change)))) {
      try { return await send(workspace,{...command,expectedRevision:refreshed.revision}); }
      catch(retryError) { throw new CommandRecoveryError(retryError,refreshed); }
    }
    throw new CommandRecoveryError(error,refreshed);
  }
}
