'use strict';

function registerSchedulerRoutes(parentApp, dependencies){
  const {
    express,
    fs,
    path,
    PROJECT_ROOT,
    ENGINE_MODES,
    runEtlTransition,
    getHopStatus,
    requestControls,
    audit,
  } = dependencies;
  const app = express.Router();

  const SCHEDULER_STATE_PATH = path.join(PROJECT_ROOT, '.vault-studio-scheduler.json');
  const SCHEDULER_LOG_LIMIT = 25;
  let schedulerRunInProgress = false;
  let schedulerState = {
    enabled: false,
    intervalMinutes: 60,
    mode: 'internal',
    nextRunAt: null,
    lastRunAt: null,
    log: [],
  };

  function loadSchedulerState(){
    try {
      const raw = fs.readFileSync(SCHEDULER_STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      schedulerState = { ...schedulerState, ...parsed };
    } catch(_) { /* no persisted state yet, or unreadable — start fresh */ }
  }
  function saveSchedulerState(){
    try { fs.writeFileSync(SCHEDULER_STATE_PATH, JSON.stringify(schedulerState, null, 2)); }
    catch(_) { /* best-effort — a failed save shouldn't crash a scheduled run */ }
  }
  function schedulerLog(entry){
    schedulerState.log.unshift({ at: new Date().toISOString(), ...entry });
    schedulerState.log = schedulerState.log.slice(0, SCHEDULER_LOG_LIMIT);
  }
  function scheduleNextRun(){
    if (schedulerState.enabled){
      schedulerState.nextRunAt = new Date(Date.now() + schedulerState.intervalMinutes * 60000).toISOString();
    }
  }
  function skippedResult(skipReason, message, ok = true){
    return { ok, skipped:true, skipReason, error:ok ? undefined : message, message };
  }
  function recordSkippedRun(reason, result){
    schedulerLog({
      ok:result.ok,
      skipped:true,
      reason,
      skipReason:result.skipReason,
      error:result.ok ? undefined : result.error,
      message:result.message,
    });
    // A scheduled skip consumes this occurrence. Move the schedule forward so
    // the 15-second poller does not repeatedly retry while Hop is still busy.
    if (reason === 'scheduled') scheduleNextRun();
    saveSchedulerState();
  }
  async function runSchedulerNow(reason){
    // The status check prevents launches while an earlier detached Hop run is
    // active. The shared ETL gate closes the smaller status-check/start race
    // against manual starts and stops.
    if (schedulerRunInProgress){
      return {
        ok:false, httpStatus:409, code:'OPERATION_IN_PROGRESS', operation:'etl-transition',
        error:'A scheduled ETL transition is already running.', retryAfterMs:1000, retryable:true,
      };
    }

    schedulerRunInProgress = true;
    try {
      const hopStatus = await getHopStatus();
      if (!hopStatus.ok){
        const detail = hopStatus.error || 'Hop container status is unavailable.';
        const result = skippedResult(
          'hop-status-unavailable',
          `Skipped because the scheduler could not safely determine whether Hop is already running: ${detail}`,
          false
        );
        recordSkippedRun(reason, result);
        return result;
      }
      if (hopStatus.running){
        const result = skippedResult(
          'hop-already-running',
          'Skipped because a Hop ETL run is already active.'
        );
        recordSkippedRun(reason, result);
        return result;
      }

      schedulerState.lastRunAt = new Date().toISOString();
      const args = ENGINE_MODES[schedulerState.mode] || ENGINE_MODES.internal; // never --build on a schedule
      const result = await runEtlTransition(args, 120000);
      schedulerLog({ ok:result.ok, reason, error:result.ok ? undefined : (result.error || 'Failed — see server logs.') });
      // Preserve existing behaviour where a manual run also resets the next
      // recurring occurrence when scheduling is enabled.
      scheduleNextRun();
      saveSchedulerState();
      return result;
    } finally {
      schedulerRunInProgress = false;
    }
  }
  loadSchedulerState();
  // Checked every 15s rather than computing a precise setTimeout for the
  // exact due time — simpler, self-correcting if the process was asleep or
  // paused (e.g. a laptop lid closed), and 15s of jitter on an hourly-or-
  // longer schedule is never going to matter.
  const schedulerInterval = setInterval(() => {
    if (schedulerRunInProgress || !schedulerState.enabled || !schedulerState.nextRunAt) return;
    if (new Date(schedulerState.nextRunAt).getTime() <= Date.now()){
      runSchedulerNow('scheduled').catch(()=>{});
    }
  }, 15000);
  schedulerInterval.unref();
  
  app.get('/api/scheduler/status', (req, res) => {
    res.json({ ok:true, ...schedulerState, running:schedulerRunInProgress });
  });
  
  app.post('/api/scheduler/config', (req, res) => {
    const { enabled, intervalMinutes, mode } = req.body || {};
    if (intervalMinutes != null){
      const n = Number(intervalMinutes);
      if (!Number.isFinite(n) || n < 1) return res.status(400).json({ ok:false, error:'intervalMinutes must be a number of 1 or more.' });
      schedulerState.intervalMinutes = n;
    }
    if (mode != null){
      if (!Object.prototype.hasOwnProperty.call(ENGINE_MODES, mode)) {
        return res.status(400).json({ ok:false, error:`Unknown engine mode "${mode}" — allowed: ${Object.keys(ENGINE_MODES).join(', ')}.` });
      }
      schedulerState.mode = mode;
    }
    if (enabled != null){
      schedulerState.enabled = !!enabled;
      schedulerState.nextRunAt = schedulerState.enabled
        ? new Date(Date.now() + schedulerState.intervalMinutes * 60000).toISOString()
        : null;
    }
    saveSchedulerState();
    audit('scheduler.changed', { enabled:schedulerState.enabled, intervalMinutes:schedulerState.intervalMinutes, mode:schedulerState.mode });
    res.json({ ok:true, ...schedulerState, running:schedulerRunInProgress });
  });
  
  app.post('/api/scheduler/run-now', async (req, res) => {
    const result = await runSchedulerNow('manual');
    if (result.httpStatus) return requestControls.sendResult(res, result, { result, ...schedulerState, running:schedulerRunInProgress });
    res.json({ ok:true, result, ...schedulerState, running:schedulerRunInProgress });
  });
  
  parentApp.use(app);
}

module.exports = { registerSchedulerRoutes };
