/** Authenticated external operations over the existing broker; owns no runtime state. */
import type { ExternalCaller } from '../shared/agent-owner.js';
import { familyIdSchema } from '../shared/agent-owner.js';
import { externalToolSchemas, externalDataSchemas, type SpawnArgs, type SpawnReceipt, type MessageArgs, type MessageReceipt, type StatusArgs, type StatusResult, type ReportQuery, type ReportPage, type AckArgs, type AckReceipt, type StopArgs, type StopReceipt } from '../shared/external-prime.js';
import { isExternalCallerAuthenticated, ExternalPrimeError } from './external-prime-auth.js';
import { getConfig } from './config.js';
import { externalPlacementGrant } from './session/conversation-access.js';
import { resolvePath } from './sandbox.js';
import { findSessionByConversation } from './session/store.js';
import { sessionControlsFor, stopSessionTurn, cancelWorkerCommands, retireObsoleteExternalStops } from './bridge.js';
import { runningExecProcesses } from './codex/ownership.js';
import { logWarn } from './logger.js';
import { stageSpawn, stageExternalResumeMessage, stageExternalStop, externalWorkerForCaller, recordExternalStopEvidence, externalStopBindingCurrent, runExternalMutation, resolveExternalFamily, requestWorkerBootstraps, requestWorkerRevivals, externalStatus, stageExternalReports, stageExternalAck, acceptStagedSwarmMutation, getExternalReceipt, measureSleepingWorkers, AgentError, type ExternalFamilyPlacement } from './agents.js';

function authorize(caller: ExternalCaller): void {
  if (!isExternalCallerAuthenticated(caller)) throw new ExternalPrimeError('ACCESS_REVOKED', 'External authentication is no longer active');
}
function parse<K extends keyof typeof externalToolSchemas>(name: K, value: unknown): ReturnType<(typeof externalToolSchemas)[K]['parse']> {
  const result = externalToolSchemas[name].safeParse(value);
  if (!result.success) throw new ExternalPrimeError('INVALID_ARGUMENT', 'Invalid external worker arguments');
  return result.data as ReturnType<(typeof externalToolSchemas)[K]['parse']>;
}
function mutationInput(operation: string, args: unknown): unknown { return JSON.parse(JSON.stringify({ operation, ...(args as object) })); }
function failure(error: unknown): never {
  if (error instanceof ExternalPrimeError) throw error;
  if (error instanceof AgentError) throw new ExternalPrimeError('INVALID_ARGUMENT', 'Worker operation is not currently admissible');
  // An invariant failure after the exact write can be uncertain; this never claims rollback.
  throw new ExternalPrimeError('PERSISTENCE_FAILED', 'Broker acceptance could not be confirmed; query the request receipt before retrying');
}
function placementFor(caller: ExternalCaller, root: string): ExternalFamilyPlacement {
  authorize(caller);
  const principal = getConfig().externalPrime.principals.find(row => row.principalId === caller.principalId)!;
  const placement = { workspaceRootId: root, browserBinding: { ...principal.browserBinding }, setupProfileId: caller.setupProfileId };
  externalPlacementGrant(caller.principalId, placement, caller.setupProfileId);
  return placement;
}

export async function spawnExternal(caller: ExternalCaller, raw: SpawnArgs): Promise<SpawnReceipt> {
  authorize(caller); const args = parse('workers_spawn', raw);
  let validatedRoot: { name: string; path: string } | undefined;
  if (!getExternalReceipt(caller, args.request_id)) {
    const placement = placementFor(caller, args.workspace_root_id);
    const roots = getConfig().roots.filter(row => row.name === placement.workspaceRootId);
    try { await resolvePath(roots, `/${placement.workspaceRootId}`); }
    catch { throw new ExternalPrimeError('INVALID_ARGUMENT', 'Approved workspace is unavailable'); }
    validatedRoot = roots[0];
    authorize(caller); placementFor(caller, args.workspace_root_id);
    if (!getConfig().roots.some(row => row.name === roots[0]?.name && row.path === roots[0]?.path)) throw new ExternalPrimeError('ACCESS_REVOKED', 'Workspace changed during admission');
  }
  let accepted;
  let publication: { ids: string[]; runId: string } | undefined;
  try {
    accepted = await runExternalMutation(caller, args.request_id, mutationInput('workers_spawn', args), () => {
      placementFor(caller, args.workspace_root_id);
      if (!validatedRoot || !getConfig().roots.some(row => row.name === validatedRoot!.name && row.path === validatedRoot!.path)) throw new ExternalPrimeError('ACCESS_REVOKED', 'Workspace changed during admission');
      const stage = stageSpawn({ caller, family: args.family, externalPlacement: placementFor(caller, args.workspace_root_id), context: args.context, workers: [{ task: args.task, model: args.model }] });
      const family = resolveExternalFamilyForStage(stage.runId, args.family);
      publication = { ids: stage.created.map(row => row.id), runId: stage.runId };
      return { ...stage, value: { operation: 'workers_spawn' as const, receipt: { request_id: args.request_id, family_id: family, worker_id: stage.created[0]!.id, run_id: stage.runId, status: 'accepted' as const } } };
    });
  } catch (error) { failure(error); }
  authorize(caller);
  if (!accepted!.replayed && publication) {
    placementFor(caller, args.workspace_root_id);
    try { requestWorkerBootstraps(publication.ids, publication.runId); }
    catch { logWarn('External worker bootstrap publication is unconfirmed; the accepted receipt is retained'); }
  }
  return externalDataSchemas.workers_spawn.parse(accepted!.value.receipt);
}
function resolveExternalFamilyForStage(runId: string, selector: SpawnArgs['family']) {
  // New family's permanent address is its first UUID, never a forged provider identity.
  return 'id' in selector ? selector.id : familyIdSchema.parse(runId);
}

export async function messageExternal(caller: ExternalCaller, raw: MessageArgs): Promise<MessageReceipt> {
  authorize(caller); const args = parse('workers_message', raw);
  if (!getExternalReceipt(caller, args.request_id)) {
    if (externalWorkerForCaller(caller, args.family_id, args.worker_id).externalStopIntent && !args.resume) throw new ExternalPrimeError('ACCESS_REVOKED', 'Worker is explicitly stopped; resume:true is required');
    const family = resolveExternalFamily(caller, args.family_id);
    externalPlacementGrant(caller.principalId, family.placement, caller.setupProfileId);
    try { await measureSleepingWorkers(caller); } catch (error) { failure(error); }
    authorize(caller);
    externalPlacementGrant(caller.principalId, resolveExternalFamily(caller, args.family_id).placement, caller.setupProfileId);
  }
  let publication: { ids: string[]; runId: string } | undefined;
  let accepted;
  try {
    accepted = await runExternalMutation(caller, args.request_id, mutationInput('workers_message', args), () => {
      const family = resolveExternalFamily(caller, args.family_id);
      externalPlacementGrant(caller.principalId, family.placement, caller.setupProfileId);
      // Ordinary sleep retains the legacy wake semantics. Explicit stop resume is Task 6.
      const stage = stageExternalResumeMessage(caller, args.family_id, args.worker_id, args.message, args.resume);
      publication = { ids: stage.waking, runId: stage.runId };
      return { ...stage, value: { operation: 'workers_message' as const, receipt: { request_id: args.request_id, family_id: args.family_id, worker_id: args.worker_id, status: 'accepted' as const } } };
    });
  } catch (error) { failure(error); }
  authorize(caller);
  if (!accepted!.replayed) retireObsoleteExternalStops(args.family_id, args.worker_id);
  if (!accepted!.replayed && publication?.ids.length) {
    externalPlacementGrant(caller.principalId, resolveExternalFamily(caller, args.family_id).placement, caller.setupProfileId);
    try { requestWorkerRevivals(publication.ids, publication.runId); }
    catch { logWarn('External worker revival publication is unconfirmed; the accepted receipt is retained'); }
  }
  return externalDataSchemas.workers_message.parse(accepted!.value.receipt);
}

export function statusExternal(caller: ExternalCaller, raw: StatusArgs): StatusResult {
  authorize(caller); const args = parse('workers_status', raw);
  return externalDataSchemas.workers_status.parse(externalStatus(caller, args));
}
export async function reportsExternal(caller: ExternalCaller, raw: ReportQuery): Promise<ReportPage> {
  authorize(caller); const args = parse('workers_reports', raw);
  let stage;
  try { stage = await acceptStagedSwarmMutation(() => stageExternalReports(caller, args)); }
  catch (error) { failure(error); }
  authorize(caller);
  return externalDataSchemas.workers_reports.parse(stage!.value);
}
export async function ackExternal(caller: ExternalCaller, raw: AckArgs): Promise<AckReceipt> {
  authorize(caller); const args = parse('workers_ack', raw);
  let accepted;
  try {
    accepted = await runExternalMutation(caller, args.request_id, mutationInput('workers_ack', args), () => {
      const stage = stageExternalAck(caller, args);
      return { ...stage, value: { operation: 'workers_ack' as const, receipt: stage.value } };
    });
  } catch (error) { failure(error); }
  authorize(caller);
  return externalDataSchemas.workers_ack.parse(accepted!.value.receipt);
}

export async function stopExternal(caller: ExternalCaller, raw: StopArgs): Promise<StopReceipt> {
  authorize(caller); const args = parse('workers_stop', raw);
  let publication: ReturnType<typeof stageExternalStop>['value'] | undefined;
  let turnId: string | undefined, sessionId: string | undefined;
  if (!getExternalReceipt(caller, args.request_id)) {
    const worker = externalWorkerForCaller(caller, args.family_id, args.worker_id);
    if (worker.conversationId) {
      const session = await findSessionByConversation(worker.conversationId, { requireUnique: true });
      if (session?.conversationId === worker.conversationId) {
        sessionId = session.id;
        try { turnId = (await sessionControlsFor(session.id)).activeTurnId ?? undefined; } catch { /* unobserved is unknown */ }
      }
    }
  }
  let accepted;
  try { accepted = await runExternalMutation(caller, args.request_id, mutationInput('workers_stop', args), () => {
    const family = resolveExternalFamily(caller, args.family_id);
    const principal = externalPlacementGrant(caller.principalId, family.placement, caller.setupProfileId);
    const stage = stageExternalStop(caller, args.family_id, args.worker_id, args.request_id, principal.policyRevision, turnId);
    publication = stage.value;
    return { ...stage, value: { operation: 'workers_stop' as const, receipt: { ...args, status: 'accepted' as const, admission: 'blocked' as const, browser: 'unknown' as const, processes: 'unknown' as const } } };
  }); } catch (error) { failure(error); }
  authorize(caller);
  if (!accepted!.replayed && publication) {
    const intent = publication.externalStopIntent!;
    cancelWorkerCommands('external worker stopped', args.worker_id, intent.runId);
    if (intent.conversationId && sessionId) {
      const binding = { principalId: caller.principalId, familyId: args.family_id,
        workerId: args.worker_id, runId: intent.runId, conversationId: intent.conversationId, policyRevision: intent.ownerRevision,
        admissionRevision: publication.externalAdmissionRevision!, stopId: args.request_id };
      try {
        const currentSession = await findSessionByConversation(intent.conversationId, { requireUnique: true });
        if (currentSession?.id !== sessionId || currentSession.conversationId !== intent.conversationId || !externalStopBindingCurrent(binding)) throw new Error('external_stop_binding_changed');
        if (runningExecProcesses(sessionId).length) await recordExternalStopEvidence(binding, { processes: 'running' });
        if (turnId) await stopSessionTurn(sessionId, turnId, binding);
      }
      catch { logWarn('External native stop delivery is unconfirmed; durable admission remains blocked'); }
    }
  }
  return externalDataSchemas.workers_stop.parse(getExternalReceipt(caller, args.request_id)?.receipt ?? accepted!.value.receipt);
}
